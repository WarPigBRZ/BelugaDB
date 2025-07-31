#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use csv::Writer;
use postgres_types::{FromSql, Type};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::error::Error;
use std::fs::File;
use std::io::{Read, Write};
use std::path::PathBuf;
use tokio::sync::oneshot;
use tokio_postgres::NoTls;
use postgis::ewkb::{EwkbRead, Geometry};



const CONNECTIONS_FILE: &str = "connections.json";

struct RawBytes(Vec<u8>);

impl<'a> FromSql<'a> for RawBytes {
    fn from_sql(_ty: &Type, raw: &'a [u8]) -> Result<Self, Box<dyn Error + Sync + Send>> {
        Ok(RawBytes(raw.to_vec()))
    }

    fn accepts(_ty: &Type) -> bool {
        true
    }
}

fn get_connections_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app.path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    Ok(app_data_dir.join(CONNECTIONS_FILE))
}

fn write_csv(path: &PathBuf, result: &QueryResult) -> Result<(), String> {
    let mut writer = match Writer::from_path(path) {
        Ok(w) => w,
        Err(e) => return Err(format!("Erro ao criar arquivo CSV: {}", e)),
    };

    if let Err(e) = writer.write_record(&result.headers) {
        return Err(format!("Erro ao escrever cabeçalhos no CSV: {}", e));
    }

    for row in &result.rows {
        if let Err(e) = writer.write_record(row) {
            return Err(format!("Erro ao escrever linha no CSV: {}", e));
        }
    }

    writer.flush().map_err(|e| format!("Erro ao finalizar CSV: {}", e))
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct Connection {
    id: String,
    name: String,
    host: String,
    port: String,
    user: String,
    pass: String,
    save_pass: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct DatabaseInfo {
    name: String,
    status: i32,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "lowercase")]
enum ExecutionStatus {
    Waiting,
    Success,
    Error,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct DatabaseStatus {
    name: String,
    status: ExecutionStatus,
    log: Option<String>,
    result: Option<QueryResult>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "lowercase")]
enum SaveOption {
    Single,
    Separate,
    None,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct QueryResult {
    headers: Vec<String>,
    rows: Vec<Vec<String>>,
}

#[tauri::command]
fn get_connections(app: tauri::AppHandle) -> Result<Vec<Connection>, String> {
    let path = get_connections_path(&app)?;
    if !path.exists() {
        return Ok(vec![]);
    }

    let mut file =
        File::open(&path).map_err(|e| format!("Erro ao abrir o arquivo: {}", e.to_string()))?;
    let mut contents = String::new();
    file.read_to_string(&mut contents)
        .map_err(|e| format!("Erro ao ler o arquivo: {}", e.to_string()))?;

    if contents.trim().is_empty() {
        return Ok(vec![]);
    }

    serde_json::from_str(&contents).map_err(|e| format!("Erro ao decodificar JSON: {}", e))
}

#[tauri::command]
fn save_connections(app: tauri::AppHandle, connections: Vec<Connection>) -> Result<(), String> {
    let path = get_connections_path(&app)?;

    // Ensure the parent directory exists
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create data directory: {}", e))?;
    }

    let json = serde_json::to_string_pretty(&connections)
        .map_err(|e| format!("Erro ao serializar: {}", e))?;

    let mut file = File::create(&path)
        .map_err(|e| format!("Erro ao criar arquivo: {}", e.to_string()))?;
    file.write_all(json.as_bytes())
        .map_err(|e| format!("Erro ao salvar: {}", e.to_string()))?;

    Ok(())
}

#[tauri::command]
fn delete_connection(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let mut connections = get_connections(app.clone())?;
    connections.retain(|c| c.name != name);
    save_connections(app, connections)?;
    Ok(())
}

#[tauri::command]
async fn get_databases(connection: Connection) -> Result<Vec<DatabaseInfo>, String> {
    let conn_str = format!(
        "host={} port={} user={} password={}",
        connection.host, connection.port, connection.user, connection.pass
    );

    let (client, conn) = tokio_postgres::connect(&conn_str, NoTls)
        .await
        .map_err(|e| format!("Erro de conexão: {}", e))?;

    tauri::async_runtime::spawn(async move {
        if let Err(e) = conn.await {
            eprintln!("Erro de conexão (background): {}", e);
        }
    });

    let rows = client
        .query("SELECT datname FROM pg_database WHERE datistemplate = false AND datname <> 'postgres'", &[])
        .await
        .map_err(|e| format!("Erro ao buscar bancos de dados: {}", e))?;

    let databases = rows.iter().map(|row| DatabaseInfo { name: row.get(0), status: 0 }).collect();
    Ok(databases)
}

// Helper function to execute a query and return a structured result
async fn execute_query_for_db(
    connection_str: &str,
    query: &str,
) -> Result<QueryResult, String> {
    let (client, connection) = tokio_postgres::connect(connection_str, NoTls)
        .await
        .map_err(|e| format!("Erro de conexão: {}", e))?;

    tauri::async_runtime::spawn(async move {
        if let Err(e) = connection.await {
            eprintln!("Erro de conexão (background): {}", e);
        }
    });

    let rows = client
        .query(query, &[])
        .await
        .map_err(|e| format!("Erro na consulta: {}", e))?;

    if rows.is_empty() {
        return Ok(QueryResult {
            headers: vec![],
            rows: vec![],
        });
    }

    let headers: Vec<String> = rows[0]
        .columns()
        .iter()
        .map(|c| c.name().to_string())
        .collect();

    let mut result_rows = Vec::new();
    for row in &rows {
        let mut values = Vec::new();
        for i in 0..row.len() {
            let col_type = row.columns()[i].type_();
            let value_str = if col_type == &Type::NUMERIC {
                row.try_get::<_, Decimal>(i)
                    .map(|d| d.to_string())
                    .unwrap_or_else(|_| "NULL".to_string())
            } else if col_type == &Type::INT2 {
                row.try_get::<_, i16>(i)
                    .map(|v| v.to_string())
                    .unwrap_or_else(|_| "NULL".to_string())
            } else if col_type == &Type::INT4 {
                row.try_get::<_, i32>(i)
                    .map(|v| v.to_string())
                    .unwrap_or_else(|_| "NULL".to_string())
            } else if col_type == &Type::INT8 {
                row.try_get::<_, i64>(i)
                    .map(|v| v.to_string())
                    .unwrap_or_else(|_| "NULL".to_string())
            } else if col_type == &Type::FLOAT4 || col_type == &Type::FLOAT8 {
                row.try_get::<_, f64>(i)
                    .map(|v| v.to_string())
                    .unwrap_or_else(|_| "NULL".to_string())
            } else if col_type.name() == "geometry" {
                row.try_get::<_, RawBytes>(i)
                    .map(|raw_bytes| {
                        let mut cursor = std::io::Cursor::new(&raw_bytes.0);
                        match Geometry::read_ewkb(&mut cursor) {
                            Ok(geom) => format!("{:?}", geom),
                            Err(_) => "GEOMETRIA_INVALIDA".to_string(),
                        }
                    })
                    .unwrap_or_else(|_| "NULL".to_string())
            } else {
                row.try_get::<_, String>(i).unwrap_or_else(|_| "NULL".to_string())
            };
            values.push(value_str);
        }
        result_rows.push(values);
    }

    Ok(QueryResult {
        headers,
        rows: result_rows,
    })
}

#[tauri::command]
async fn execute_query_on_databases(
    app: tauri::AppHandle,
    connection: Connection,
    databases: Vec<String>,
    query: String,
    save_option: SaveOption,
) -> Result<(), String> {
    // 1. Lida com os diálogos primeiro, pois eles precisam ser aguardados no contexto async principal.
        let save_path: Option<PathBuf> = match save_option {
            SaveOption::Separate | SaveOption::Single => {
                let (tx, rx) = oneshot::channel();
                app.dialog().file().pick_folder(move |folder| {
                    let _ = tx.send(folder);
                });
                match rx.await {
                    Ok(Some(file_path)) => match file_path.into_path() {
                        Ok(path) => Some(path),
                        Err(_) => return Err("Erro ao extrair o caminho da pasta selecionada".to_string()),
                    },
                    Ok(None) => return Ok(()),
                    Err(_) => return Err("Erro ao receber a pasta selecionada.".to_string()),
                }
            }
            SaveOption::None => None,
        };





    // 2. Inicia a tarefa de longa duração em segundo plano.
    tauri::async_runtime::spawn(async move {
        // Acumule os resultados se for SaveOption::Single
        let mut all_results: Vec<(String, QueryResult)> = Vec::new();

        for db_name in databases {
            let conn_str = format!(
                "host={} port={} user={} password={} dbname={}",
                connection.host, connection.port, connection.user, connection.pass, db_name
            );

            let execution_result = execute_query_for_db(&conn_str, &query).await;

            let mut status = match execution_result {
                Ok(query_result) => {
                    // Acumula para salvar depois, se for SaveOption::Single
                    if let SaveOption::Single = save_option {
                        all_results.push((db_name.clone(), query_result.clone()));
                    }
                    DatabaseStatus {
                        name: db_name.clone(),
                        status: ExecutionStatus::Success,
                        log: None,
                        result: Some(query_result),
                    }
                }
                Err(e) => DatabaseStatus {
                    name: db_name.clone(),
                    status: ExecutionStatus::Error,
                    log: Some(e.to_string()),
                    result: None,
                },
            };

            // Salva separado, se for o caso
            if let (Some(folder_path), Some(query_result), SaveOption::Separate) = (&save_path, &status.result, &save_option) {
                let file_path = folder_path.join(format!("{}.csv", db_name));
                if let Err(e) = write_csv(&file_path, query_result) {
                    status.status = ExecutionStatus::Error;
                    status.log = Some(format!("Sucesso na query, mas falha ao salvar CSV: {}", e));
                }
            }

            if let Err(e) = app.emit("execution-status-update", &status) {
                eprintln!("Failed to emit status update: {}", e);
            }
        }

        // Após o loop, salve tudo em um único arquivo se for SaveOption::Single
        if let SaveOption::Single = save_option {
            if let Some(folder_path) = &save_path {
                let file_path = folder_path.join("resultado_unico.csv");
                if let Err(e) = write_all_csv(&file_path, &all_results) {
                    eprintln!("Erro ao salvar CSV único: {}", e);
                }
            }
        }
    });

    Ok(())
}

fn write_all_csv(path: &PathBuf, results: &[(String, QueryResult)]) -> Result<(), String> {
    let mut writer = csv::Writer::from_path(path)
        .map_err(|e| format!("Erro ao criar arquivo CSV: {}", e))?;

    // Descobre o maior conjunto de headers
    let mut all_headers = vec!["db".to_string()];
    if let Some((_, first_result)) = results.iter().find(|(_, r)| !r.headers.is_empty()) {
        all_headers.extend(first_result.headers.clone());
    }

    writer.write_record(&all_headers).map_err(|e| e.to_string())?;

    for (db_name, result) in results {
        for row in &result.rows {
            let mut record = Vec::with_capacity(1 + row.len());
            record.push(db_name.clone());
            record.extend(row.iter().cloned());
            writer.write_record(&record).map_err(|e| e.to_string())?;
        }
    }

    writer.flush().map_err(|e| format!("Erro ao finalizar CSV: {}", e))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_connections,
            save_connections,
            delete_connection,
            get_databases,
            execute_query_on_databases,
        ])
        .run(tauri::generate_context!())
        .expect("Erro ao iniciar o app");
}
