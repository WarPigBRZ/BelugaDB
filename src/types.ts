// Esta interface DEVE ter a mesma estrutura da struct `QueryResult`
// no arquivo `src-tauri/src/main.rs`
export interface QueryResult {
  db_name: string;
  output: string;
  success: boolean;
}