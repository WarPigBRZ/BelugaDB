#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]
use chrono::Utc;
use csv::Writer;
use postgis::ewkb::{EwkbRead, Geometry};
use postgres_types::{FromSql, Type};
use rusqlite::Connection as RusqliteConnection;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::error::Error;
use std::fs;
use std::fs::File;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;
use tokio_postgres::NoTls;

// --- STRUCTS (sem alterações) ---
const CONNECTIONS_FILE: &str = "connections.json";
struct RawBytes(Vec<u8>);
impl<'a> FromSql<'a> for RawBytes {
    fn from_sql(_ty: &Type, raw: &'a [u8]) -> Result<Self, Box<dyn Error + Sync + Send>> { Ok(RawBytes(raw.to_vec())) }
    fn accepts(_ty: &Type) -> bool { true }
}
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct Connection { id: String, name: String, host: String, port: String, user: String, pass: String, save_pass: bool, }
#[derive(Serialize, Deserialize, Debug, Clone)]
struct DatabaseInfo { name: String, status: i32, }
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
enum ExecutionStatus { Waiting, Success, Error, }
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct DatabaseStatus { name: String, status: ExecutionStatus, log: Option<String>, results: Vec<ExecutionResult>, }
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
enum ExecutionResult { Select(QueryResult), Mutation { affected_rows: u64 }, Error(String), }
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "lowercase")]
enum SaveOption { Single, Separate, None, }
#[derive(Serialize, Deserialize, Debug, Clone)]
struct QueryResult { headers: Vec<String>, rows: Vec<Vec<String>>, }
#[derive(Serialize, Clone)]
struct HistoryEntry { id: i64, query_text: String, connection_name: String, status: String, timestamp: String, }
#[derive(Serialize, Clone)]
struct Snippet { id: i64, name: String, description: String, content: String, }
#[derive(Deserialize)]
struct SnippetPayload { name: String, description: String, content: String, }
pub struct DbConnection(pub Mutex<Option<RusqliteConnection>>);

// --- SETUP DO BANCO DE DADOS (sem alterações) ---
fn setup_database(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let app_data_dir = app.path().app_data_dir().expect("Failed to get app data dir");
    if !app_data_dir.exists() { fs::create_dir_all(&app_data_dir)?; }
    let db_path = app_data_dir.join("history.sqlite");
    let conn = RusqliteConnection::open(db_path)?;
    conn.execute("CREATE TABLE IF NOT EXISTS query_history (id INTEGER PRIMARY KEY AUTOINCREMENT, query_text TEXT NOT NULL, connection_name TEXT NOT NULL, status TEXT NOT NULL, timestamp TEXT NOT NULL)", [], )?;
    conn.execute("CREATE TABLE IF NOT EXISTS snippets (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT, content TEXT NOT NULL)", [], )?;
    app.state::<DbConnection>().0.lock().unwrap().replace(conn);
    Ok(())
}

// --- COMANDOS TAURI (sem alterações, exceto execute_query_on_databases) ---
#[tauri::command]
fn add_query_to_history(conn_state: State<DbConnection>, query_text: String, connection_name: String, status: String) -> Result<(), String> {
    let db_conn_mutex = conn_state.0.lock().map_err(|e| e.to_string())?;
    let db_conn = db_conn_mutex.as_ref().ok_or("Database connection not initialized")?;
    let timestamp = Utc::now().to_rfc3339();
    db_conn.execute("INSERT INTO query_history (query_text, connection_name, status, timestamp) VALUES (?1, ?2, ?3, ?4)", &[&query_text, &connection_name, &status, &timestamp], ).map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
fn get_query_history(conn_state: State<DbConnection>) -> Result<Vec<HistoryEntry>, String> {
    let db_conn_mutex = conn_state.0.lock().map_err(|e| e.to_string())?;
    let db_conn = db_conn_mutex.as_ref().ok_or("Database connection not initialized")?;
    let mut stmt = db_conn.prepare("SELECT id, query_text, connection_name, status, timestamp FROM query_history ORDER BY id DESC").map_err(|e| e.to_string())?;
    let history_iter = stmt.query_map([], |row| { Ok(HistoryEntry { id: row.get(0)?, query_text: row.get(1)?, connection_name: row.get(2)?, status: row.get(3)?, timestamp: row.get(4)?, }) }).map_err(|e| e.to_string())?;
    let mut history = Vec::new();
    for entry in history_iter { history.push(entry.map_err(|e| e.to_string())?); }
    Ok(history)
}
#[tauri::command]
fn clear_query_history(conn_state: State<DbConnection>) -> Result<(), String> {
    let db_conn_mutex = conn_state.0.lock().map_err(|e| e.to_string())?;
    let db_conn = db_conn_mutex.as_ref().ok_or("Database connection not initialized")?;
    db_conn.execute("DELETE FROM query_history", []).map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
fn create_snippet(payload: SnippetPayload, conn_state: State<DbConnection>) -> Result<(), String> {
    let db_conn_mutex = conn_state.0.lock().map_err(|e| e.to_string())?;
    let db_conn = db_conn_mutex.as_ref().ok_or("DB connection not initialized")?;
    db_conn.execute("INSERT INTO snippets (name, description, content) VALUES (?1, ?2, ?3)", &[&payload.name, &payload.description, &payload.content], ).map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
fn get_snippets(conn_state: State<DbConnection>) -> Result<Vec<Snippet>, String> {
    let db_conn_mutex = conn_state.0.lock().map_err(|e| e.to_string())?;
    let db_conn = db_conn_mutex.as_ref().ok_or("DB connection not initialized")?;
    let mut stmt = db_conn.prepare("SELECT id, name, description, content FROM snippets ORDER BY name ASC").map_err(|e| e.to_string())?;
    let snippet_iter = stmt.query_map([], |row| { Ok(Snippet { id: row.get(0)?, name: row.get(1)?, description: row.get(2)?, content: row.get(3)?, }) }).map_err(|e| e.to_string())?;
    let mut snippets = Vec::new();
    for entry in snippet_iter { snippets.push(entry.map_err(|e| e.to_string())?); }
    Ok(snippets)
}
#[tauri::command]
fn update_snippet(id: i64, payload: SnippetPayload, conn_state: State<DbConnection>) -> Result<(), String> {
    let db_conn_mutex = conn_state.0.lock().map_err(|e| e.to_string())?;
    let db_conn = db_conn_mutex.as_ref().ok_or("DB connection not initialized")?;
    db_conn.execute("UPDATE snippets SET name = ?1, description = ?2, content = ?3 WHERE id = ?4", &[&payload.name, &payload.description, &payload.content, &id.to_string()], ).map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
fn delete_snippet(id: i64, conn_state: State<DbConnection>) -> Result<(), String> {
    let db_conn_mutex = conn_state.0.lock().map_err(|e| e.to_string())?;
    let db_conn = db_conn_mutex.as_ref().ok_or("DB connection not initialized")?;
    db_conn.execute("DELETE FROM snippets WHERE id = ?1", &[&id.to_string()]).map_err(|e| e.to_string())?;
    Ok(())
}
fn get_connections_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(app_data_dir.join(CONNECTIONS_FILE))
}
fn write_csv(path: &PathBuf, result: &QueryResult) -> Result<(), String> {
    let mut writer = Writer::from_path(path).map_err(|e| format!("Erro ao criar CSV: {}", e))?;
    writer.write_record(&result.headers).map_err(|e| format!("Erro ao escrever cabeçalhos: {}", e))?;
    for row in &result.rows { writer.write_record(row).map_err(|e| format!("Erro ao escrever linha: {}", e))?; }
    writer.flush().map_err(|e| format!("Erro ao finalizar CSV: {}", e))
}
#[tauri::command]
fn get_connections(app: tauri::AppHandle) -> Result<Vec<Connection>, String> {
    let path = get_connections_path(&app)?;
    if !path.exists() { return Ok(vec![]); }
    let mut file = File::open(&path).map_err(|e| e.to_string())?;
    let mut contents = String::new();
    file.read_to_string(&mut contents).map_err(|e| e.to_string())?;
    if contents.trim().is_empty() { return Ok(vec![]); }
    serde_json::from_str(&contents).map_err(|e| e.to_string())
}
#[tauri::command]
fn save_connections(app: tauri::AppHandle, connections: Vec<Connection>) -> Result<(), String> {
    let path = get_connections_path(&app)?;
    if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|e| format!("Failed to create data directory: {}", e))?; }
    let json = serde_json::to_string_pretty(&connections).map_err(|e| e.to_string())?;
    let mut file = File::create(&path).map_err(|e| e.to_string())?;
    file.write_all(json.as_bytes()).map_err(|e| e.to_string())
}
#[tauri::command]
async fn get_databases(connection: Connection) -> Result<Vec<DatabaseInfo>, String> {
    let conn_str = format!("host={} port={} user={} password={}", connection.host, connection.port, connection.user, connection.pass);
    let (client, conn) = tokio_postgres::connect(&conn_str, NoTls).await.map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn(async move { if let Err(e) = conn.await { eprintln!("Connection error: {}", e); } });
    let rows = client.query("SELECT datname FROM pg_database WHERE datistemplate = false AND datname <> 'postgres'", &[]).await.map_err(|e| e.to_string())?;
    Ok(rows.iter().map(|row| DatabaseInfo { name: row.get(0), status: 0 }).collect())
}
async fn execute_single_query(connection_str: &str, query: &str) -> Result<ExecutionResult, String> {
    let (client, connection) = tokio_postgres::connect(connection_str, NoTls).await.map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn(async move { if let Err(e) = connection.await { eprintln!("Connection error: {}", e); } });
    let is_select = query.trim().to_lowercase().starts_with("select");
    if is_select {
        let rows = client.query(query, &[]).await.map_err(|e| e.to_string())?;
        if rows.is_empty() { return Ok(ExecutionResult::Select(QueryResult { headers: vec![], rows: vec![] })); }
        let headers: Vec<String> = rows[0].columns().iter().map(|c| c.name().to_string()).collect();
        let mut result_rows = Vec::new();
        for row in &rows {
            let mut values = Vec::new();
            for i in 0..row.len() {
                let col_type = row.columns()[i].type_();
                let value_str = if col_type == &Type::NUMERIC { row.try_get::<_, Decimal>(i).map(|d| d.to_string()).unwrap_or_else(|_| "NULL".to_string()) }
                else if col_type == &Type::INT2 { row.try_get::<_, i16>(i).map(|v| v.to_string()).unwrap_or_else(|_| "NULL".to_string()) }
                else if col_type == &Type::INT4 { row.try_get::<_, i32>(i).map(|v| v.to_string()).unwrap_or_else(|_| "NULL".to_string()) }
                else if col_type == &Type::INT8 { row.try_get::<_, i64>(i).map(|v| v.to_string()).unwrap_or_else(|_| "NULL".to_string()) }
                else if col_type == &Type::FLOAT4 || col_type == &Type::FLOAT8 { row.try_get::<_, f64>(i).map(|v| v.to_string()).unwrap_or_else(|_| "NULL".to_string()) }
                else if col_type.name() == "geometry" { row.try_get::<_, RawBytes>(i).map(|raw_bytes| { let mut cursor = std::io::Cursor::new(&raw_bytes.0); match Geometry::read_ewkb(&mut cursor) { Ok(geom) => format!("{:?}", geom), Err(_) => "GEOMETRY_INVALID".to_string(), } }).unwrap_or_else(|_| "NULL".to_string()) }
                else { row.try_get::<_, String>(i).unwrap_or_else(|_| "NULL".to_string()) };
                values.push(value_str);
            }
            result_rows.push(values);
        }
        Ok(ExecutionResult::Select(QueryResult { headers, rows: result_rows }))
    } else {
        let affected_rows = client.execute(query, &[]).await.map_err(|e| e.to_string())?;
        Ok(ExecutionResult::Mutation { affected_rows })
    }
}

// CORREÇÃO: A lógica de execução foi restaurada aqui.
#[tauri::command]
async fn execute_query_on_databases(app: tauri::AppHandle, connection: Connection, databases: Vec<String>, query: String, save_option: SaveOption, stop_on_error: bool) -> Result<(), String> {
    let save_path: Option<PathBuf> = match save_option {
        SaveOption::Separate | SaveOption::Single => {
            let (tx, rx) = oneshot::channel();
            app.dialog().file().pick_folder(move |folder| { let _ = tx.send(folder); });
            match rx.await {
                Ok(Some(path)) => Some(path.into_path().map_err(|_| "Path conversion failed".to_string())?),
                Ok(None) => return Ok(()),
                Err(_) => return Err("Failed to receive selected folder".to_string()),
            }
        }
        SaveOption::None => None,
    };

    tauri::async_runtime::spawn(async move {
        let mut all_results_for_csv: Vec<(String, QueryResult)> = Vec::new();
        let queries: Vec<&str> = query.split(';').map(|q| q.trim()).filter(|q| !q.is_empty()).collect();

        if queries.is_empty() { return; }

        for db_name in databases {
            let conn_str = format!("host={} port={} user={} password={} dbname={}", connection.host, connection.port, connection.user, connection.pass, db_name);
            let mut results_for_this_db: Vec<ExecutionResult> = Vec::new();
            let mut has_error = false;

            for (i, single_query) in queries.iter().enumerate() {
                match execute_single_query(&conn_str, single_query).await {
                    Ok(result) => { results_for_this_db.push(result); }
                    Err(e) => {
                        has_error = true;
                        let error_msg = format!("Erro na query {}: {}", i + 1, e);
                        results_for_this_db.push(ExecutionResult::Error(error_msg));
                        if stop_on_error { break; }
                    }
                }
            }

            let execution_status = if has_error { ExecutionStatus::Error } else { ExecutionStatus::Success };
            let successes = results_for_this_db.iter().filter(|r| !matches!(r, ExecutionResult::Error(_))).count();
            let failures = results_for_this_db.len() - successes;
            let log_message = if failures > 0 { format!("{} com sucesso, {} com falha.", successes, failures) } else { format!("{} queries executadas com sucesso.", successes) };
            
            let mut status = DatabaseStatus { name: db_name.clone(), status: execution_status, log: Some(log_message), results: results_for_this_db };
            
            let last_select_result = status.results.iter().filter_map(|r| match r { ExecutionResult::Select(qr) => Some(qr), _ => None }).last();

            if let (Some(folder_path), Some(query_result), SaveOption::Separate) = (&save_path, last_select_result, &save_option) {
                let file_path = folder_path.join(format!("{}.csv", db_name));
                if let Err(e) = write_csv(&file_path, query_result) {
                    status.status = ExecutionStatus::Error;
                    status.log = Some(format!("Sucesso na query, mas falha ao salvar CSV: {}", e));
                }
            }

            if let (Some(query_result), SaveOption::Single) = (last_select_result, &save_option) {
                if status.status == ExecutionStatus::Success {
                    all_results_for_csv.push((db_name.clone(), query_result.clone()));
                }
            }

            if let Err(e) = app.emit("execution-status-update", &status) {
                eprintln!("Failed to emit status update: {}", e);
            }
        }

        if let (SaveOption::Single, Some(folder_path)) = (save_option, &save_path) {
            if !all_results_for_csv.is_empty() {
                let file_path = folder_path.join("resultado_unico.csv");
                if let Err(e) = write_all_csv(&file_path, &all_results_for_csv) {
                    eprintln!("Erro ao salvar CSV único: {}", e);
                }
            }
        }
    });

    Ok(())
}
fn write_all_csv(path: &PathBuf, results: &[(String, QueryResult)]) -> Result<(), String> {
    let mut writer = csv::Writer::from_path(path).map_err(|e| e.to_string())?;
    let mut all_headers = vec!["db".to_string()];
    if let Some((_, first_result)) = results.iter().find(|(_, r)| !r.headers.is_empty()) { all_headers.extend(first_result.headers.clone()); }
    writer.write_record(&all_headers).map_err(|e| e.to_string())?;
    for (db_name, result) in results {
        for row in &result.rows {
            let mut record = Vec::with_capacity(1 + row.len());
            record.push(db_name.clone());
            record.extend(row.iter().cloned());
            writer.write_record(&record).map_err(|e| e.to_string())?;
        }
    }
    writer.flush().map_err(|e| e.to_string())
}


fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(DbConnection(Mutex::new(None)))
        .setup(|app| {
            setup_database(&app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_connections,
            save_connections,
            get_databases,
            execute_query_on_databases,
            add_query_to_history,
            get_query_history,
            clear_query_history,
            create_snippet,
            get_snippets,
            update_snippet,
            delete_snippet
        ])
        .run(tauri::generate_context!())
        .expect("Erro ao iniciar o app");
}