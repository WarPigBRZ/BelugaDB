import { useState, useEffect } from 'react';
import './App.css';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useNotification } from './NotificationContext.tsx';
import Editor from 'react-simple-code-editor';
import Prism, { highlight } from 'prismjs';
import 'prismjs/components/prism-sql';
import 'prismjs/themes/prism-tomorrow.css';

// --- DEFINIÇÕES DE TIPOS ---
type Screen = 'connections' | 'query' | 'execution';
type SaveOption = 'single' | 'separate' | 'none';
type UtilityPanelTab = 'history' | 'snippets';

interface Connection {
  id: string;
  name: string;
  host: string;
  port: string;
  user: string;
  pass: string;
  savePass: boolean;
}
type ConnectionFormData = Omit<Connection, 'id'>;
type ExecutionStatus = 'waiting' | 'success' | 'error';
interface QueryResult {
  headers: string[];
  rows: string[][];
}
type ExecutionResult =
  | { type: 'select'; payload: QueryResult }
  | { type: 'mutation'; payload: { affectedRows: number } }
  | { type: 'error'; payload: string };
interface DatabaseStatus {
  name: string;
  status: ExecutionStatus;
  log?: string;
  results: ExecutionResult[];
}
interface DatabaseInfo {
  name: string;
  status: number;
}
interface HistoryEntry {
    id: number;
    query_text: string;
    connection_name: string;
    status: string;
    timestamp: string;
}
interface Snippet {
    id: number;
    name: string;
    description: string;
    content: string;
}
type SnippetFormData = Omit<Snippet, 'id'>;


// --- COMPONENTES DE MODAL ---
const SnippetModal = ({
    isOpen,
    onClose,
    onSave,
    initialData,
}: {
    isOpen: boolean;
    onClose: () => void;
    onSave: (data: SnippetFormData) => void;
    initialData?: Snippet;
}) => {
    const emptyForm: SnippetFormData = { name: '', description: '', content: '' };
    const [formData, setFormData] = useState(initialData || emptyForm);
    const isEditing = !!initialData;

    useEffect(() => {
        setFormData(initialData || emptyForm);
    }, [initialData, isOpen]);

    if (!isOpen) return null;

    const handleSave = () => {
        if (formData.name && formData.content) {
            onSave(formData);
        }
    };

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content snippet-modal-content" onClick={(e) => e.stopPropagation()}>
                <h2>{isEditing ? 'Editar Snippet' : 'Novo Snippet'}</h2>
                <div className="modal-form">
                    <input
                        type="text"
                        placeholder="Nome do Snippet"
                        value={formData.name}
                        onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                    />
                    <input
                        type="text"
                        placeholder="Descrição (opcional)"
                        value={formData.description}
                        onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                    />
                    <div className="snippet-editor">
                        <Editor
                            value={formData.content}
                            onValueChange={code => setFormData(prev => ({...prev, content: code}))}
                            highlight={code => highlight(code, Prism.languages.sql, 'sql')}
                            padding={10}
                            textareaClassName="search-input"
                            placeholder="Cole seu script SQL aqui..."
                        />
                    </div>
                    <div className="modal-actions">
                        <button type="button" onClick={onClose} className="action-button">Cancelar</button>
                        <button type="button" onClick={handleSave} className="action-button save-button">Salvar</button>
                    </div>
                </div>
            </div>
        </div>
    );
};
const ExecutionResultModal = ({ isOpen, onClose, results }: { isOpen: boolean; onClose: () => void; results: ExecutionResult[] | null; }) => {
  const [activeTabIndex, setActiveTabIndex] = useState(0);
  useEffect(() => { if (isOpen) setActiveTabIndex(0); }, [isOpen, results]);
  if (!isOpen || !results || results.length === 0) return null;
  const getTabInfo = (result: ExecutionResult, index: number) => {
    switch (result.type) {
      case 'select': return { icon: '📄', label: `SELECT (${result.payload.rows.length} linhas)` };
      case 'mutation': return { icon: '✔️', label: `Mutação` };
      case 'error': return { icon: '❌', label: `Erro Query ${index + 1}` };
      default: return { icon: '❓', label: `Query ${index + 1}` };
    }
  };
  const activeResult = results[activeTabIndex];
  return (
    <div className="modal-overlay" onClick={onClose}><div className="modal-content result-modal-content" onClick={(e) => e.stopPropagation()}><h2>Resultados da Execução</h2><div className="tab-container"><div className="tab-buttons">{results.map((result, index) => { const { icon, label } = getTabInfo(result, index); return (<button key={index} className={`tab-button ${index === activeTabIndex ? 'active' : ''}`} onClick={() => setActiveTabIndex(index)}><span>{icon}</span><span>{label}</span></button>); })}</div><div className="tab-content">{activeResult.type === 'select' ? (<div className="result-table-container">{activeResult.payload.rows.length > 0 ? (<table><thead><tr>{activeResult.payload.headers.map((h, i) => <th key={i}>{h}</th>)}</tr></thead><tbody>{activeResult.payload.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody></table>) : <p><i>Query executada com sucesso, mas não retornou linhas.</i></p>}</div>) : activeResult.type === 'mutation' ? (<p className="mutation-result">✔️ Sucesso! {activeResult.payload.affectedRows} linha(s) afetada(s).</p>) : <p className="error-result">❌ {activeResult.payload}</p>}</div></div><div className="modal-actions"><button type="button" onClick={onClose} className="action-button">Fechar</button></div></div></div>
  );
};
const LogModal = ({ isOpen, onClose, logs }: { isOpen: boolean; onClose: () => void; logs: DatabaseStatus[]; }) => {
    if (!isOpen) return null;
    return (<div className="modal-overlay" onClick={onClose}><div className="modal-content log-modal-content" onClick={(e) => e.stopPropagation()}><h2>Logs de Erro</h2><div className="log-entries">{logs.map((log, index) => (<div key={index} className="log-entry"><h4>{log.name}</h4><pre>{log.log}</pre></div>))}</div><div className="modal-actions"><button type="button" onClick={onClose} className="action-button">Fechar</button></div></div></div>);
};
const ReturnOptionsModal = ({ isOpen, onClose, onSelectPrevious, onSelectErrors }: { isOpen: boolean; onClose: () => void; onSelectPrevious: () => void; onSelectErrors: () => void; }) => {
    if (!isOpen) return null;
    return (<div className="modal-overlay" onClick={onClose}><div className="modal-content" onClick={(e) => e.stopPropagation()}><h2>Opções de Retorno</h2><p>Selecione qual tipo de seleção você deseja manter ao retornar para a página anterior.</p><div className="modal-actions return-options"><button type="button" onClick={onSelectPrevious} className="action-button">Seleção Anterior</button><button type="button" onClick={onSelectErrors} className="action-button">Somente Erros</button><button type="button" onClick={onClose} className="action-button">Cancelar</button></div></div></div>);
};
const SaveOptionsModal = ({ isOpen, onClose, onSelect }: { isOpen: boolean; onClose: () => void; onSelect: (option: SaveOption) => void; }) => {
    if (!isOpen) return null;
    return (<div className="modal-overlay" onClick={onClose}><div className="modal-content" onClick={(e) => e.stopPropagation()}><h2>Salvar Resultados</h2><p>Como você deseja salvar os resultados da query?</p><div className="modal-actions return-options"><button type="button" onClick={() => onSelect('single')} className="action-button">Arquivo Único</button><button type="button" onClick={() => onSelect('separate')} className="action-button">Arquivos Separados</button><button type="button" onClick={() => onSelect('none')} className="action-button">Não Salvar</button><button type="button" onClick={onClose} className="action-button">Cancelar</button></div></div></div>);
};
const ConnectionModal = ({ mode, isOpen, onClose, onSave, initialValues }: { mode: 'new' | 'edit'; isOpen: boolean; onClose: () => void; onSave: (data: ConnectionFormData) => void; initialValues?: ConnectionFormData; }) => {
  const emptyForm: ConnectionFormData = { name: '', host: '', port: '', user: '', pass: '', savePass: false };
  const [formData, setFormData] = useState(initialValues || emptyForm);
  useEffect(() => { if (isOpen) { setFormData(initialValues || emptyForm); } }, [isOpen, initialValues]);
  if (!isOpen) { return null; }
  const handleSubmit = (e: React.FormEvent) => { e.preventDefault(); if (formData.name.trim()) { onSave(formData); } };
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => { const { name, value, type, checked } = e.target; setFormData(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value, })); };
  return (
    <div className="modal-overlay" onClick={onClose}><div className="modal-content" onClick={(e) => e.stopPropagation()}><h2>{mode === 'new' ? 'Nova Conexão' : 'Editar Conexão'}</h2><form onSubmit={handleSubmit} className="modal-form"><input type="text" name="name" value={formData.name} onChange={handleChange} placeholder="Nome da Conexão" autoFocus /><input type="text" name="host" value={formData.host} onChange={handleChange} placeholder="IP do Servidor" /><input type="text" name="port" value={formData.port} onChange={handleChange} placeholder="Porta do Servidor" /><input type="text" name="user" value={formData.user} onChange={handleChange} placeholder="Usuário" /><input type="password" name="pass" value={formData.pass} onChange={handleChange} placeholder="Senha" /><div><label className="checkbox-label"><input type="checkbox" name="savePass" checked={formData.savePass} onChange={handleChange} /> Salvar Senha</label></div><div className="modal-actions"><button type="button" onClick={onClose} className="action-button">Cancelar</button><button type="submit" className="action-button save-button">Salvar</button></div></form></div></div>
  );
};
const ConfirmDeleteModal = ({ isOpen, onClose, onConfirm }: { isOpen: boolean; onClose: () => void; onConfirm: () => void; }) => {
    if (!isOpen) { return null; }
    return (<div className="modal-overlay" onClick={onClose}><div className="modal-content" onClick={(e) => e.stopPropagation()}><h2>Confirmar Exclusão</h2><p>Tem certeza que deseja excluir esta conexão?</p><div className="modal-actions"><button type="button" onClick={onClose} className="action-button">Cancelar</button><button type="button" onClick={onConfirm} className="action-button delete-button">Excluir</button></div></div></div>);
};


// --- PAINEL DE UTILIDADES (HISTÓRICO E SNIPPETS) ---
const UtilityPanel = ({ onSelectQuery, active }: { onSelectQuery: (query: string) => void; active: boolean }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<UtilityPanelTab>('history');
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [isSnippetModalOpen, setIsSnippetModalOpen] = useState(false);
  const [editingSnippet, setEditingSnippet] = useState<Snippet | undefined>(undefined);
  const { showNotification } = useNotification();

  const fetchHistory = () => invoke<HistoryEntry[]>('get_query_history').then(setHistory).catch(console.error);
  const fetchSnippets = () => invoke<Snippet[]>('get_snippets').then(setSnippets).catch(console.error);

  useEffect(() => {
    if (active && isExpanded) {
      if (activeTab === 'history') fetchHistory();
      else fetchSnippets();
    }
  }, [active, isExpanded, activeTab]);

  const handleClearHistory = (e: React.MouseEvent) => {
    e.stopPropagation();
    invoke('clear_query_history').then(() => {
        setHistory([]);
        showNotification("Histórico limpo com sucesso!");
    }).catch(err => showNotification(`Erro ao limpar histórico: ${err}`));
  };

  const handleSaveSnippet = (data: SnippetFormData) => {
    const promise = editingSnippet
        ? invoke('update_snippet', { id: editingSnippet.id, payload: data })
        : invoke('create_snippet', { payload: data });
    promise.then(() => {
        showNotification(editingSnippet ? "Snippet atualizado!" : "Snippet salvo!");
        fetchSnippets();
    }).catch(err => showNotification(`Erro: ${err}`));
    setIsSnippetModalOpen(false);
    setEditingSnippet(undefined);
  };
  
  const handleDeleteSnippet = (id: number) => {
      invoke('delete_snippet', { id })
        .then(() => {
            showNotification("Snippet excluído!");
            fetchSnippets();
        })
        .catch(err => showNotification(`Erro ao excluir snippet: ${err}`));
  };

  return (
    <>
      <SnippetModal isOpen={isSnippetModalOpen} onClose={() => setIsSnippetModalOpen(false)} onSave={handleSaveSnippet} initialData={editingSnippet} />
      <div className={`utility-panel ${isExpanded ? 'expanded' : ''}`}>
        <div className="utility-header" onClick={() => setIsExpanded(!isExpanded)}>
          <div className="utility-tabs">
            <button className={`utility-tab-button ${activeTab === 'history' ? 'active' : ''}`} onClick={(e) => { e.stopPropagation(); setActiveTab('history'); }}>Histórico</button>
            <button className={`utility-tab-button ${activeTab === 'snippets' ? 'active' : ''}`} onClick={(e) => { e.stopPropagation(); setActiveTab('snippets'); }}>Snippets</button>
          </div>
          <div className="utility-header-actions">
            {activeTab === 'history' && (
                <button onClick={handleClearHistory} className="action-button delete-button header-action-button" title="Limpar Histórico">
                    🗑️
                </button>
            )}
            <span className="collapse-icon">{isExpanded ? '▲' : '▼'}</span>
          </div>
        </div>
        {isExpanded && (
          <div className="utility-content">
            {activeTab === 'history' && (
                <div className="history-list">
                    {history.length > 0 ? (
                        <ul>{history.map(entry => (
                            <li key={entry.id} onClick={() => onSelectQuery(entry.query_text)}>
                                <pre className="language-sql" dangerouslySetInnerHTML={{ __html: highlight(entry.query_text, Prism.languages.sql, 'sql')}}/>
                                <span className="history-query-details">{entry.connection_name} - {new Date(entry.timestamp).toLocaleString()}</span>
                            </li>))}
                        </ul>
                    ) : <p className="empty-message">Nenhuma query no histórico.</p>}
                </div>
            )}
            {activeTab === 'snippets' && (
                <div className="snippets-list">
                    <button onClick={() => { setEditingSnippet(undefined); setIsSnippetModalOpen(true); }} className="action-button new-snippet-button">Novo Snippet</button>
                    {snippets.length > 0 ? (
                        <ul>{snippets.map(snippet => (
                            <li key={snippet.id}>
                                <div className="snippet-info">
                                    <strong>{snippet.name}</strong>
                                    <p>{snippet.description}</p>
                                </div>
                                <div className="snippet-actions">
                                <button className="action-button" onClick={() => onSelectQuery(snippet.content)}>Usar</button>
                                <button className="action-button" onClick={() => { setEditingSnippet(snippet); setIsSnippetModalOpen(true); }}>Editar</button>
                                <button className="action-button delete-button" onClick={() => handleDeleteSnippet(snippet.id)}>Excluir</button>
                                </div>
                            </li>))}
                        </ul>
                    ) : <p className="empty-message">Nenhum snippet salvo.</p>}
                </div>
            )}
          </div>
        )}
      </div>
    </>
  );
};


// --- COMPONENTES DE TELA ---
const QueryScreen = ({
  connection,
  databases,
  setDatabases,
  isLoading,
  error,
  onBack,
  onExecute,
  query,
  setQuery,
}: {
  connection: Connection;
  databases: { id: string; name: string; checked: boolean; status: number }[];
  setDatabases: React.Dispatch<React.SetStateAction<{ id: string; name: string; checked: boolean; status: number }[]>>;
  isLoading: boolean;
  error: string | null;
  onBack: () => void;
  onExecute: (query: string, databases: string[], saveOption: SaveOption, stopOnError: boolean) => void;
  query: string;
  setQuery: (query: string) => void;
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [isAllSelected, setIsAllSelected] = useState(true);
  const [isSaveOptionsModalOpen, setIsSaveOptionsModalOpen] = useState(false);
  const [stopOnErrorFlag, setStopOnErrorFlag] = useState(false);

  useEffect(() => { localStorage.setItem('userQuery', query); }, [query]);
  useEffect(() => { if (databases.length > 0) setIsAllSelected(databases.every(db => db.checked)); else setIsAllSelected(false); }, [databases]);

  const handleSelectAll = (e: React.ChangeEvent<HTMLInputElement>) => { setIsAllSelected(e.target.checked); setDatabases(dbs => dbs.map(db => ({...db, checked: e.target.checked}))); };
  const handleDbCheck = (dbId: string) => { setDatabases(dbs => dbs.map(db => db.id === dbId ? {...db, checked: !db.checked } : db)); };
  const handleExecuteClick = (stopOnError: boolean) => { setStopOnErrorFlag(stopOnError); setIsSaveOptionsModalOpen(true); };
  const handleSaveOptionSelect = (saveOption: SaveOption) => {
    const selectedDbs = databases.filter(db => db.checked).map(db => db.name);
    onExecute(query, selectedDbs, saveOption, stopOnErrorFlag);
    setIsSaveOptionsModalOpen(false);
  };
  const filteredDatabases = databases.filter(db => db.name.toLowerCase().includes(searchTerm.toLowerCase()));

  return (
    <div className="query-screen-container">
      <SaveOptionsModal isOpen={isSaveOptionsModalOpen} onClose={() => setIsSaveOptionsModalOpen(false)} onSelect={handleSaveOptionSelect} />
       <div className="query-screen-header">
        <h3 className="connection-nickname">{connection.name} {!isLoading && !error && `(${databases.length})`}</h3>
        <div className="database-controls-bar">
          <input type="search" placeholder="Pesquisar banco..." className="search-input" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
          <label className="checkbox-label select-all-label"><input type="checkbox" checked={isAllSelected} onChange={handleSelectAll} />Todos</label>
        </div>
      </div>
      {isLoading && <div className="loading-state">Carregando bancos de dados...</div>}
      {error && <div className="error-state"><h3>Erro ao carregar bancos</h3><p>{error}</p></div>}
      {!isLoading && !error && (
        <>
          <div className="database-list">
            <div className="database-list-grid">
              {filteredDatabases.map(db => (
                <label key={db.id} className={`checkbox-label ${db.status < 0 ? 'disabled' : ''}`} >
                  <input type="checkbox" checked={db.checked} onChange={() => handleDbCheck(db.id)} disabled={db.status < 0}/>
                  {db.name}
                </label>
              ))}
            </div>
          </div>
          <div className="query-editor">
            <h3>Query</h3>
            <Editor value={query} onValueChange={setQuery} highlight={(code) => highlight(code, Prism.languages.sql, 'sql')} padding={12} textareaId="query-editor" textareaClassName="search-input" placeholder="Insira sua Query aqui" />
          </div>
          <div className="screen-actions">
            <button onClick={onBack} className="action-button">Voltar</button>
            <button onClick={() => handleExecuteClick(true)} className="action-button warning-button">Executar Sequencial</button>
            <button onClick={() => handleExecuteClick(false)} className="action-button save-button">Executar</button>
          </div>
          <UtilityPanel onSelectQuery={setQuery} active={true} />
        </>
      )}
    </div>
  );
};
const ExecutionScreen = ({ databases, onBack, }: { databases: string[]; onBack: (results: DatabaseStatus[]) => void; }) => {
    const [results, setResults] = useState<DatabaseStatus[]>(() => databases.map(name => ({ name, status: 'waiting' as ExecutionStatus, log: undefined, results: [] })));
    const [isLogModalOpen, setIsLogModalOpen] = useState(false);
    const [isResultModalOpen, setIsResultModalOpen] = useState(false);
    const [selectedResults, setSelectedResults] = useState<ExecutionResult[] | null>(null);
    useEffect(() => { setResults(databases.map(name => ({ name, status: 'waiting' as ExecutionStatus, log: undefined, results: [] }))); const unlistenPromise = listen<DatabaseStatus>('execution-status-update', (event) => { setResults(prevResults => prevResults.map(res => res.name === event.payload.name ? event.payload : res)); }); return () => { unlistenPromise.then(fn => fn()); }; }, [databases]);
    const getStatusIcon = (status: ExecutionStatus) => { if (status === 'waiting') return <span className="status-icon waiting">🟡</span>; if (status === 'success') return <span className="status-icon success">✔️</span>; if (status === 'error') return <span className="status-icon error">❌</span>; return null; };
    const handleViewResult = (results: ExecutionResult[] | undefined) => { if (results && results.length > 0) { setSelectedResults(results); setIsResultModalOpen(true); } };
    const errorLogs = results.filter(r => r.status === 'error' && r.log);
    return (
        <div className="execution-screen-container"><LogModal isOpen={isLogModalOpen} onClose={() => setIsLogModalOpen(false)} logs={errorLogs} /><ExecutionResultModal isOpen={isResultModalOpen} onClose={() => setIsResultModalOpen(false)} results={selectedResults} /><div className="execution-list"><ul>{results.map(result => (<li key={result.name}><span>{result.name}</span><div className="status-container">{result.results && result.results.length > 0 && <button className="view-result-button" onClick={() => handleViewResult(result.results)}>👁️</button>}{getStatusIcon(result.status)}</div></li>))}</ul></div><div className="screen-actions"><button onClick={() => setIsLogModalOpen(true)} className="action-button" disabled={errorLogs.length === 0}>Logs</button><button onClick={() => onBack(results)} className="action-button">Voltar</button></div></div>
    );
};


// --- COMPONENTE PRINCIPAL ---
function App() {
  const { notification, showNotification } = useNotification();
  const [screen, setScreen] = useState<Screen>('connections');
  const [connections, setConnections] = useState<Connection[]>([]);
  const [databases, setDatabases] = useState<{ id: string; name: string; checked: boolean; status: number }[]>([]);
  const [isLoadingDatabases, setIsLoadingDatabases] = useState(true);
  const [dbError, setDbError] = useState<string | null>(null);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<'new' | 'edit'>('new');
  const [executionData, setExecutionData] = useState<{ query: string; databases: string[] } | null>(null);
  const [isConfirmDeleteOpen, setIsConfirmDeleteOpen] = useState(false);
  const [isReturnModalOpen, setIsReturnModalOpen] = useState(false);
  const [lastExecutionResults, setLastExecutionResults] = useState<DatabaseStatus[] | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [query, setQuery] = useState(() => localStorage.getItem('userQuery') || '');

  const selectedConnection = connections.find(c => c.id === selectedConnectionId);

  useEffect(() => {
    invoke<Connection[]>('get_connections')
      .then(savedConnections => { setConnections(savedConnections); })
      .catch(err => { showNotification("Erro ao carregar conexões salvas."); })
      .finally(() => { setIsLoaded(true); });
  }, [showNotification]);

  useEffect(() => {
    if (!isLoaded) return;
    invoke('save_connections', { connections })
      .catch(err => { showNotification("Erro ao salvar conexões."); });
  }, [connections, isLoaded, showNotification]);

  useEffect(() => {
    const unlistenPromise = listen<string>('save-status-update', (event) => { showNotification(event.payload); });
    return () => { unlistenPromise.then(fn => fn()); };
  }, [showNotification]);

  useEffect(() => {
    if (screen === 'query' && selectedConnection) {
      setIsLoadingDatabases(true);
      setDbError(null);
      invoke<DatabaseInfo[]>('get_databases', { connection: selectedConnection })
        .then(dbInfos => {
          const formattedDbs = dbInfos.map((db, index) => ({ id: `db-${index}`, name: db.name, checked: true, status: db.status, })).sort((a, b) => a.name.localeCompare(b.name));
          setDatabases(formattedDbs);
        })
        .catch(err => { setDbError(err as string); })
        .finally(() => { setIsLoadingDatabases(false); });
    }
  }, [screen, selectedConnection]);

  const handleConnectionSelect = (connectionId: string) => { setSelectedConnectionId(currentId => (currentId === connectionId ? null : connectionId)); };
  const handleConnect = () => { if (selectedConnectionId) { setScreen('query'); } };
  const handleOpenModal = (mode: 'new' | 'edit') => { if (mode === 'edit' && !selectedConnectionId) return; setModalMode(mode); setIsModalOpen(true); };
  const handleCloseModal = () => { setIsModalOpen(false); if (modalMode === 'edit') setSelectedConnectionId(null); };
  const handleSaveConnection = (connectionData: ConnectionFormData) => { if (modalMode === 'new') { const newConnection: Connection = { id: Date.now().toString(), ...connectionData, }; setConnections([...connections, newConnection]); showNotification("Nova conexão adicionada!"); } else if (modalMode === 'edit' && selectedConnectionId) { setConnections(connections.map(conn => conn.id === selectedConnectionId ? { ...conn, ...connectionData } : conn)); showNotification("Conexão salva!"); } handleCloseModal(); };
  const handleDeleteConnection = () => { if (selectedConnectionId) { setIsConfirmDeleteOpen(true); } };
  const handleConfirmDelete = () => { if (selectedConnectionId) { setConnections(connections.filter(conn => conn.id !== selectedConnectionId)); showNotification("Conexão deletada."); setSelectedConnectionId(null); handleCloseConfirmDelete(); } };
  const handleCloseConfirmDelete = () => { setIsConfirmDeleteOpen(false); };
  const handleBackToConnections = () => { setScreen('connections'); setDatabases([]); };

  const handleExecute = (query: string, databases: string[], saveOption: SaveOption, stopOnError: boolean) => {
    if (!selectedConnection || databases.length === 0 || !query.trim()) {
      showNotification("Erro: Verifique a conexão, bancos de dados e a query.");
      return;
    }
    invoke('add_query_to_history', { queryText: query, connectionName: selectedConnection.name, status: 'executed', }).catch(console.error);
    invoke('execute_query_on_databases', { connection: selectedConnection, databases, query, saveOption, stopOnError }).catch(err => { showNotification(`Erro ao iniciar execução: ${err}`); });
    setExecutionData({ query, databases });
    setScreen('execution');
  };

  const handleBackFromExecution = (results: DatabaseStatus[]) => { setLastExecutionResults(results); setIsReturnModalOpen(true); };
  const handleReturnSelectPrevious = () => { setIsReturnModalOpen(false); setScreen('query'); };
  const handleReturnSelectErrors = () => { if (lastExecutionResults) { const errorDbNames = new Set(lastExecutionResults.filter(r => r.status === 'error').map(r => r.name)); setDatabases(prevDbs => prevDbs.map(db => ({ ...db, checked: errorDbNames.has(db.name) }))); } setIsReturnModalOpen(false); setScreen('query'); };
  const handleReturnCancel = () => { setIsReturnModalOpen(false); };

  const renderConnectionsScreen = () => (
    <div className="connections-container">
      <img src="/Logo.png" alt="Logo Beluga" style={{ width: 250, margin: '2rem auto 1rem auto', display: 'block' }} />
      <div className="connections-content">
        <div className="connections-list">
          <ul>{connections.map((connection) => (<li key={connection.id} onClick={() => handleConnectionSelect(connection.id)} className={selectedConnectionId === connection.id ? 'selected' : ''}>{connection.name}</li>))}</ul>
        </div>
        <div className="connection-actions">
          <button type="button" disabled={!selectedConnectionId} className="action-button connect-button" onClick={handleConnect}>Conectar</button>
          <button type="button" className="action-button" onClick={() => handleOpenModal('new')}>Novo</button>
          <button type="button" disabled={!selectedConnectionId} className="action-button" onClick={() => handleOpenModal('edit')}>Editar</button>
          <button type="button" disabled={!selectedConnectionId} className="action-button delete-button" onClick={handleDeleteConnection}>Deletar</button>
        </div>
      </div>
    </div>
  );

  return (
    <div className={`container screen-${screen}`}>
      <ConnectionModal mode={modalMode} isOpen={isModalOpen} onClose={handleCloseModal} onSave={handleSaveConnection} initialValues={modalMode === 'edit' ? selectedConnection : undefined} />
      <ConfirmDeleteModal isOpen={isConfirmDeleteOpen} onClose={handleCloseConfirmDelete} onConfirm={handleConfirmDelete} />
      <ReturnOptionsModal isOpen={isReturnModalOpen} onClose={handleReturnCancel} onSelectPrevious={handleReturnSelectPrevious} onSelectErrors={handleReturnSelectErrors} />
      {notification && (<div className="notification slide-in-out">{notification}</div>)}
      {screen === 'connections' && renderConnectionsScreen()}
      {screen === 'query' && selectedConnection && (
        <QueryScreen 
            connection={selectedConnection}
            databases={databases}
            setDatabases={setDatabases}
            isLoading={isLoadingDatabases}
            error={dbError}
            onBack={handleBackToConnections}
            onExecute={handleExecute}
            query={query}
            setQuery={setQuery}
        />
      )}
      {screen === 'execution' && executionData && (
        <ExecutionScreen
          databases={executionData.databases}
          onBack={handleBackFromExecution}
        />
      )}
    </div>
  );
}

export default App;