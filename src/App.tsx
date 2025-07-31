import { useState, useEffect, useRef } from 'react';
import './App.css';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useNotification } from './NotificationContext.tsx';
import Editor from 'react-simple-code-editor';
import Prism from 'prismjs';
import 'prismjs/components/prism-sql';
import 'prismjs/themes/prism-tomorrow.css'; // Ou crie seu próprio tema

// Define os tipos de telas que a aplicação terá
type Screen = 'connections' | 'query' | 'execution';
type SaveOption = 'single' | 'separate' | 'none';

// Define a estrutura completa de uma conexão
interface Connection {
  id: string;
  name: string;
  host: string;
  port: string;
  user: string;
  pass: string;
  savePass: boolean;
}

// Define um tipo para os dados do formulário, que é uma Conexão sem o ID
type ConnectionFormData = Omit<Connection, 'id'>;

// --- Tipos e Componentes para a Tela 3 (Tela de Execução) ---

type ExecutionStatus = 'waiting' | 'success' | 'error';

// Estrutura para os resultados de uma query SELECT
interface QueryResult {
  headers: string[];
  rows: string[][];
}

interface DatabaseStatus {
  name: string;
  status: ExecutionStatus;
  log?: string;
  result?: QueryResult;
}

const QueryResultModal = ({
  isOpen,
  onClose,
  result,
}: {
  isOpen: boolean;
  onClose: () => void;
  result: QueryResult | null;
}) => {
  if (!isOpen || !result) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content result-modal-content" onClick={(e) => e.stopPropagation()}>
        <h2>Resultado da Query</h2>
        <div className="result-table-container">
          <table>
            <thead>
              <tr>
                {result.headers.map((header, index) => (
                  <th key={index}>{header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="modal-actions">
          <button type="button" onClick={onClose} className="action-button">
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
};

const LogModal = ({
  isOpen,
  onClose,
  logs,
}: {
  isOpen: boolean;
  onClose: () => void;
  logs: DatabaseStatus[];
}) => {
  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content log-modal-content" onClick={(e) => e.stopPropagation()}>
        <h2>Logs de Erro</h2>
        <div className="log-entries">
          {logs.map((log, index) => (
            <div key={index} className="log-entry">
              <h4>{log.name}</h4>
              <pre>{log.log}</pre>
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button type="button" onClick={onClose} className="action-button">
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
};

const ReturnOptionsModal = ({
  isOpen,
  onClose,
  onSelectPrevious,
  onSelectErrors,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSelectPrevious: () => void;
  onSelectErrors: () => void;
}) => {
  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h2>Opções de Retorno</h2>
        <p>Selecione qual tipo de seleção você deseja manter ao retornar para a página anterior.</p>
        <div className="modal-actions return-options">
          <button type="button" onClick={onSelectPrevious} className="action-button">
            Seleção Anterior
          </button>
          <button type="button" onClick={onSelectErrors} className="action-button">
            Somente Erros
          </button>
          <button type="button" onClick={onClose} className="action-button">
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
};

const SaveOptionsModal = ({
  isOpen,
  onClose,
  onSelect,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (option: SaveOption) => void;
}) => {
  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h2>Salvar Resultados</h2>
        <p>Como você deseja salvar os resultados da query?</p>
        <div className="modal-actions return-options">
          <button type="button" onClick={() => onSelect('single')} className="action-button">
            Arquivo Único
          </button>
          <button type="button" onClick={() => onSelect('separate')} className="action-button">
            Arquivos Separados
          </button>
          <button type="button" onClick={() => onSelect('none')} className="action-button">
            Não Salvar
          </button>
          <button type="button" onClick={onClose} className="action-button delete-button">
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
};

const ExecutionScreen = ({
  databases,
  onBack,
}: {
  databases: string[];
  onBack: (results: DatabaseStatus[]) => void;
}) => {
  // Inicializa ou reseta o estado dos resultados sempre que a tela é exibida com novos bancos
  const [results, setResults] = useState<DatabaseStatus[]>(() =>
    databases.map(name => ({ name, status: 'waiting' as ExecutionStatus, log: undefined }))
  );
  const [isLogModalOpen, setIsLogModalOpen] = useState(false);
  const [isResultModalOpen, setIsResultModalOpen] = useState(false);
  const [selectedResult, setSelectedResult] = useState<QueryResult | null>(null);

  useEffect(() => {
    // Garante que a lista seja resetada se o usuário voltar e executar novamente
    setResults(databases.map(name => ({ name, status: 'waiting' as ExecutionStatus, log: undefined })));

// Escuta os eventos de status vindos do Rust
    const unlistenPromise = listen<DatabaseStatus>('execution-status-update', (event) => {
      console.log('Status update received:', event.payload);
      setResults(prevResults =>
        prevResults.map(res =>
          res.name === event.payload.name ? event.payload : res
        )
      );
    });

    // Função de limpeza para remover o listener quando o componente é desmontado
    return () => {
      unlistenPromise.then(fn => fn());
    };
  }, [databases]); // A dependência em `databases` garante que o efeito rode novamente se a lista mudar

  const getStatusIcon = (status: ExecutionStatus) => {
    if (status === 'waiting') return <span className="status-icon waiting">🟡</span>;
    if (status === 'success') return <span className="status-icon success">✔️</span>;
    if (status === 'error') return <span className="status-icon error">❌</span>;
    return null;
  };

  const handleViewResult = (result: QueryResult | undefined) => {
    if (result) {
      setSelectedResult(result);
      setIsResultModalOpen(true);
    }
  };

  const errorLogs = results.filter(r => r.status === 'error' && r.log);

  return (
    <div className="execution-screen-container">
      <LogModal isOpen={isLogModalOpen} onClose={() => setIsLogModalOpen(false)} logs={errorLogs} />
      <QueryResultModal
        isOpen={isResultModalOpen}
        onClose={() => setIsResultModalOpen(false)}
        result={selectedResult}
      />
      <div className="execution-list">
        <ul>
          {results.map(result => (
            <li key={result.name}>
              <span>{result.name}</span>
              <div className="status-container">
                {result.result && <button className="view-result-button" onClick={() => handleViewResult(result.result)}>👁️</button>}
                {getStatusIcon(result.status)}
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="screen-actions">
        <button onClick={() => setIsLogModalOpen(true)} className="action-button" disabled={errorLogs.length === 0}>Logs</button>
        <button onClick={() => onBack(results)} className="action-button">Voltar</button>
      </div>
    </div>
  );
};

// --- Componente para a Tela 2 (Tela de Query) ---
const QueryScreen = ({
  connection,
  databases,
  setDatabases,
  isLoading,
  error,
  onBack,
  onExecute,
}: {
  connection: Connection;
  databases: { id: string; name: string; checked: boolean; status: number }[];
  setDatabases: React.Dispatch<React.SetStateAction<{ id: string; name: string; checked: boolean; status: number }[]>>;
  isLoading: boolean;
  error: string | null;
  onBack: () => void;
  onExecute: (query: string, databases: string[], saveOption: SaveOption) => void;
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [isAllSelected, setIsAllSelected] = useState(true);
  const [query, setQuery] = useState(() => localStorage.getItem('userQuery') || '');

  // Efeito para sincronizar o estado do "Selecionar Todos"
  useEffect(() => {
    if (databases.length > 0) {
      setIsAllSelected(databases.every(db => db.checked));
    } else {
      setIsAllSelected(false);
    }
  }, [databases]);

  useEffect(() => {
    localStorage.setItem('userQuery', query);
  }, [query]);

  const handleDbCheck = (dbId: string) => {
    setDatabases(
      databases.map(db =>
        db.id === dbId ? { ...db, checked: !db.checked } : db
      )
    );
  };

  const handleSelectAll = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { checked } = e.target;
    setIsAllSelected(checked);
    setDatabases(databases.map(db => ({ ...db, checked })));
  };

  const [isSaveOptionsModalOpen, setIsSaveOptionsModalOpen] = useState(false);

  const handleExecuteClick = () => {
    setIsSaveOptionsModalOpen(true);
  };

  const handleSaveOptionSelect = (saveOption: SaveOption) => {
    const selectedDbs = databases.filter(db => db.checked).map(db => db.name);
    onExecute(query, selectedDbs, saveOption);
    setIsSaveOptionsModalOpen(false);
  };

  const filteredDatabases = databases.filter(db =>
    db.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const highlight = (code: string) => Prism.highlight(code, Prism.languages.sql, 'sql');

  return (
    <div className="query-screen-container">
      <SaveOptionsModal
        isOpen={isSaveOptionsModalOpen}
        onClose={() => setIsSaveOptionsModalOpen(false)}
        onSelect={handleSaveOptionSelect}
      />
      <div className="query-screen-header">
        <h3 className="connection-nickname">
          {connection.name} {!isLoading && !error && `(${databases.length})`}
        </h3>
        <div className="database-controls-bar">
          <input
            type="search"
            placeholder="Pesquisar banco..."
            className="search-input"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          <label className="checkbox-label select-all-label">
            <input type="checkbox" checked={isAllSelected} onChange={handleSelectAll} />
            Todos
          </label>
        </div>
      </div>
      {isLoading && <div className="loading-state">Carregando bancos de dados...</div>}
      {error && <div className="error-state"><h3>Erro ao carregar bancos</h3><p>{error}</p></div>}
      {!isLoading && !error && (
        <>
          <div className="database-list">
            <div className="database-list-grid">
              {filteredDatabases.map(db => (
                <label 
                  key={db.id} 
                  className={`checkbox-label ${db.status === -1 || db.status === -2 ? 'disabled' : ''}`}
                >
                  <input type="checkbox" checked={db.checked} onChange={() => handleDbCheck(db.id)} />
                  {db.name}
                </label>
              ))}
            </div>
          </div>

      <div className="query-editor">
        <h3>Query</h3>
        <Editor
          value={query}
          onValueChange={setQuery}
          highlight={highlight}
          padding={12}
          textareaId="query-editor"
          textareaClassName="search-input"
          placeholder="Insira sua Query aqui"
        />
      </div>

      <div className="screen-actions">
        <button onClick={onBack} className="action-button">Voltar</button>
        <button onClick={handleExecuteClick} className="action-button save-button">Executar</button>
      </div>
        </>
      )}
    </div>
  );
};

// Componente do Modal
const ConnectionModal = ({
  mode,
  isOpen,
  onClose,
  onSave,
  initialValues,
}: {
  mode: 'new' | 'edit';
  isOpen: boolean;
  onClose: () => void;
  onSave: (data: ConnectionFormData) => void;
  initialValues?: ConnectionFormData;
}) => {
  const emptyForm: ConnectionFormData = {
    name: '',
    host: '',
    port: '',
    user: '',
    pass: '',
    savePass: false,
  };

  const [formData, setFormData] = useState(initialValues || emptyForm);

  // Sincroniza o estado do formulário quando o modal abre ou os valores iniciais mudam
  useEffect(() => {
    if (isOpen) {
      setFormData(initialValues || emptyForm);
    }
  }, [isOpen, initialValues]);

if (!isOpen) {
    return null;
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (formData.name.trim()) {
      onSave(formData);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value,
    }));
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>

        <h2>{mode === 'new' ? 'Nova Conexão' : 'Editar Conexão'}</h2>

        <form onSubmit={handleSubmit} className="modal-form">
          <input
            type="text"
            name="name"
            value={formData.name}
          onChange={handleChange}
            placeholder="Nome da Conexão"
            autoFocus
          />
          <input
            type="text"
            name="host"
            value={formData.host}
            onChange={handleChange}
            placeholder="IP do Servidor"
          />
          <input
            type="text"
            name="port"
            value={formData.port}
            onChange={handleChange}
            placeholder="Porta do Servidor"
          />
          <input
            type="text"
            name="user"
            value={formData.user}
            onChange={handleChange}
            placeholder="Usuário"
          />
           <input
            type="password"
            name="pass"
            value={formData.pass}
            onChange={handleChange}
            placeholder="Senha"
          />
           <div>
          <label className="checkbox-label">
            <input type="checkbox" name="savePass" checked={formData.savePass} onChange={handleChange} />
            Salvar Senha
          </label>
          </div>
          <div className="modal-actions">
            <button type="button" onClick={onClose} className="action-button">
              Cancelar
            </button>
            <button type="submit" className="action-button save-button">
              Salvar
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

// Componente do Modal de Confirmação
const ConfirmDeleteModal = ({
  isOpen,
  onClose,
  onConfirm,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) => {
  if (!isOpen) {
    return null;
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h2>Confirmar Exclusão</h2>
        <p>Tem certeza que deseja excluir esta conexão?</p>
        <div className="modal-actions">
          <button type="button" onClick={onClose} className="action-button">
            Cancelar
          </button>
          <button type="button" onClick={onConfirm} className="action-button delete-button">
            Excluir
          </button>
        </div>
      </div>
    </div>
  );
};
function App() {
  // Estado para controlar qual tela está ativa
  const { notification, showNotification } = useNotification();
  const [screen, setScreen] = useState<Screen>('connections');

  const [connections, setConnections] = useState<Connection[]>([]);

  // Estados levantados da QueryScreen
  const [databases, setDatabases] = useState<{ id: string; name: string; checked: boolean; status: number }[]>([]);
  const [isLoadingDatabases, setIsLoadingDatabases] = useState(true);
  const [dbError, setDbError] = useState<string | null>(null);

  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);

  // --- Estados para o Modal ---
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<'new' | 'edit'>('new');

  // --- Estado para os dados da execução ---
  const [executionData, setExecutionData] = useState<{ query: string; databases: string[] } | null>(null);

  // --- Estados para o Modal de Confirmação de Exclusão ---
  const [isConfirmDeleteOpen, setIsConfirmDeleteOpen] = useState(false);

  // --- Estados para o Modal de Opções de Retorno ---
  const [isReturnModalOpen, setIsReturnModalOpen] = useState(false);
  const [lastExecutionResults, setLastExecutionResults] = useState<DatabaseStatus[] | null>(null);

  const isInitialMount = useRef(true);
  const selectedConnection = connections.find(c => c.id === selectedConnectionId);

  // Efeito para carregar as conexões do backend na inicialização
  useEffect(() => {
    invoke<Connection[]>('get_connections')
      .then(savedConnections => {
        setConnections(savedConnections);
      })
      .catch(err => {
        console.error("Falha ao carregar conexões:", err);
        showNotification("Erro ao carregar conexões salvas.");
      });
  }, []); // Array vazio significa que roda apenas uma vez, no mount.

  // Efeito para salvar as conexões no backend sempre que a lista mudar
  useEffect(() => {
    // Não salva na primeira renderização (que é quando carregamos os dados)
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }

    invoke('save_connections', { connections })
      .catch(err => {
        console.error("Falha ao salvar conexões:", err);
        showNotification("Erro ao salvar conexões.");
      });
  }, [connections]); // Roda sempre que `connections` mudar.
  
  // Efeito para ouvir o status do salvamento de arquivo único
  useEffect(() => {
    const unlistenPromise = listen<string>('save-status-update', (event) => {
      showNotification(event.payload);
    });
    return () => {
      unlistenPromise.then(fn => fn());
    };
  }, [showNotification]);

  // Efeito para buscar os bancos de dados quando uma conexão é selecionada
  useEffect(() => {
    // Apenas busca os bancos se estivermos na tela de query com uma conexão selecionada
    // E a lista de bancos ainda não foi carregada.
    // Isso evita que a lista seja resetada ao voltar da tela de execução.
    if (screen === 'query' && selectedConnection && databases.length === 0) {
      const fetchDatabases = async () => {
        setIsLoadingDatabases(true);
        setDbError(null);
        try {
          interface DatabaseInfo { name: string; status: number; }
          const dbInfos = await invoke<DatabaseInfo[]>('get_databases', { connection: selectedConnection });
          const formattedDbs = dbInfos
            .map((db, index) => ({
              id: `db-${index}`,
              name: db.name,
              checked: true,
              status: db.status,
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
          setDatabases(formattedDbs);
        } catch (err) {
          setDbError(err as string);
          console.error("Falha ao buscar bancos de dados:", err);
        } finally {
          setIsLoadingDatabases(false);
        }
      };

      fetchDatabases();
    }
  }, [screen, selectedConnection, databases.length]);

  // Função para lidar com a seleção de um item na lista
  const handleConnectionSelect = (connectionId: string) => {
    // Se o usuário clicar na conexão já selecionada, desmarque-a
    setSelectedConnectionId(currentId => (currentId === connectionId ? null : connectionId));
  };

  // Função para navegar para a próxima tela
  const handleConnect = () => {
    if (selectedConnectionId) {
      setScreen('query');
    }
  };

  // Funções para gerenciar o Modal
  const handleOpenModal = (mode: 'new' | 'edit') => {
    // Não abre o modal de edição se nada estiver selecionado
    if (mode === 'edit' && !selectedConnectionId) return;
    setModalMode(mode);
    setIsModalOpen(true);
  };

  const handleCloseModal = () => {
    setIsModalOpen(false);
    // Limpa a seleção ao fechar para evitar bugs de edição
    if (modalMode === 'edit') setSelectedConnectionId(null);
  };

  const handleSaveConnection = (connectionData: ConnectionFormData) => {
    if (modalMode === 'new') {      
      const newConnection: Connection = {
        id: Date.now().toString(), // ID simples para o exemplo
        ...connectionData,
      };
      setConnections([...connections, newConnection]);
      showNotification("Nova conexão adicionada!");
    } else if (modalMode === 'edit' && selectedConnectionId) {
      setConnections(
        connections.map(conn =>
          conn.id === selectedConnectionId ? { ...conn, ...connectionData } : conn
        )
      );
      showNotification("Conexão salva!");
    }
    handleCloseModal();
  };

  // Funções para o Modal de Confirmação de Delete
  const handleDeleteConnection = () => {
    if (selectedConnectionId) {      
      setIsConfirmDeleteOpen(true);
    }
  };
 
   const handleConfirmDelete = () => {
    if (selectedConnectionId) {
      setConnections(connections.filter(conn => conn.id !== selectedConnectionId));
      showNotification("Conexão deletada.");
      setSelectedConnectionId(null); // Desseleciona após deletar
      handleCloseConfirmDelete();
    }
  };

  const handleCloseConfirmDelete = () => {
    setIsConfirmDeleteOpen(false);
  };

  // Função para voltar para a tela de conexões
  const handleBackToConnections = () => {
    setScreen('connections');
    setDatabases([]); // Limpa a lista de bancos para forçar a recarga na próxima conexão.
  }

  // Função para lidar com a execução da query (leva para a Tela 3)
  const handleExecute = (query: string, databases: string[], saveOption: SaveOption) => {
    if (databases.length === 0) {
      showNotification("Erro: Nenhum banco de dados selecionado.");
      return;
    }
    if (!query.trim()) {
      showNotification("Erro: A query não pode estar vazia.");
      return;
    }
    console.log("Executando query:", query, "nos bancos:", databases);
    // Chama o comando Rust para iniciar a execução em background.
    // O Rust vai emitir eventos para atualizar a UI.
    invoke('execute_query_on_databases', { connection: selectedConnection, databases, query, saveOption })
      .catch(err => {
        showNotification(`Erro ao iniciar execução: ${err}`);
      });
    setExecutionData({ query, databases });
    setScreen('execution');
  }

  // Funções para o Modal de Opções de Retorno
  const handleBackFromExecution = (results: DatabaseStatus[]) => {
    setLastExecutionResults(results);
    setIsReturnModalOpen(true);
  };

  const handleReturnSelectPrevious = () => {
    // Apenas volta para a tela de query, mantendo a seleção de bancos como estava
    setIsReturnModalOpen(false);
    setScreen('query');
  };

  const handleReturnSelectErrors = () => {
    if (lastExecutionResults) {
      const errorDbNames = new Set(lastExecutionResults.filter(r => r.status === 'error').map(r => r.name));
      setDatabases(prevDbs => prevDbs.map(db => ({ ...db, checked: errorDbNames.has(db.name) })));
    }
    setIsReturnModalOpen(false);
    setScreen('query');
  };

  const handleReturnCancel = () => {
    setIsReturnModalOpen(false);
  };
  
  // Renderiza a tela de conexões
  const renderConnectionsScreen = () => (
  <div className="connections-container">
    {/* Logo no topo */}
    <img
      src="/Logo.png"
      alt="Logo Beluga"
      style={{ width: 250, margin: '2rem auto 1rem auto', display: 'block' }}
    />
    <div className="connections-content">
      {/* Lista de Conexões */}
      <div className="connections-list">
        <ul>
          {connections.map((connection) => (
            <li
              key={connection.id}
              onClick={() => handleConnectionSelect(connection.id)}
              className={selectedConnectionId === connection.id ? 'selected' : ''}
            >
              {connection.name}
            </li>
          ))}
        </ul>
      </div>

        {/* Ações para a conexão selecionada */}
        <div className="connection-actions">
          <button
            type="button"
            disabled={!selectedConnectionId}
            className="action-button connect-button"
            onClick={handleConnect}
          >
            Conectar
          </button>
          <button type="button" className="action-button" onClick={() => handleOpenModal('new')}>
            Novo
          </button>
          <button
            type="button"
            disabled={!selectedConnectionId}
            className="action-button"
            onClick={() => handleOpenModal('edit')}
          >
            Editar
          </button>
          <button
            type="button"
            disabled={!selectedConnectionId}
            className="action-button"
            onClick={handleDeleteConnection}
          >
            Deletar
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className={`container screen-${screen}`}>
      <ConnectionModal
        mode={modalMode}
        isOpen={isModalOpen}
        onClose={handleCloseModal}
        onSave={handleSaveConnection}
        initialValues={modalMode === 'edit' ? selectedConnection : undefined}
      />
      <ConfirmDeleteModal
        isOpen={isConfirmDeleteOpen}
        onClose={handleCloseConfirmDelete}
        onConfirm={handleConfirmDelete}
      />
      <ReturnOptionsModal
        isOpen={isReturnModalOpen}
        onClose={handleReturnCancel}
        onSelectPrevious={handleReturnSelectPrevious}
        onSelectErrors={handleReturnSelectErrors}
      />

      {/* Renderização condicional baseada na tela atual */}
      {notification && (
        <div className="notification slide-in-out">
          {notification}
        </div>
      )}
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
