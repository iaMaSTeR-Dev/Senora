import React, { useState, useEffect } from 'react';
import {
  Server,
  Plus,
  Trash2,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Edit2,
  Check,
  X,
  Wifi,
  Shield,
  Phone,
  HardDrive,
  Info,
  ChevronRight,
  ChevronDown,
  Globe,
} from 'lucide-react';
import { serverManager, SavedServer, ServerDiscovery } from '../../protocol/serverManager';

interface ServerSelectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onServerSwitched?: (newServer: SavedServer) => void;
}

export const ServerSelectionModal: React.FC<ServerSelectionModalProps> = ({
  isOpen,
  onClose,
  onServerSwitched,
}) => {
  const [servers, setServers] = useState<SavedServer[]>([]);
  const [activeServer, setActiveServer] = useState<SavedServer>(serverManager.getActiveServer());
  const [selectedDetailsServer, setSelectedDetailsServer] = useState<SavedServer | null>(null);

  // Add Server Form State
  const [showAddForm, setShowAddForm] = useState(false);
  const [newUrl, setNewUrl] = useState('');
  const [newName, setNewName] = useState('');
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    latencyMs: number;
    discovery?: ServerDiscovery;
    error?: string;
  } | null>(null);
  const [addError, setAddError] = useState<string | null>(null);

  // Editing Name State
  const [editingServerId, setEditingServerId] = useState<string | null>(null);
  const [editNameValue, setEditNameValue] = useState('');

  // Instructions Accordion State
  const [showInstructions, setShowInstructions] = useState(false);

  useEffect(() => {
    if (isOpen) {
      refreshServers();
    }
  }, [isOpen]);

  const refreshServers = () => {
    setServers(serverManager.getSavedServers());
    setActiveServer(serverManager.getActiveServer());
  };

  if (!isOpen) return null;

  const handleTestConnection = async () => {
    if (!newUrl.trim()) {
      setAddError('Please enter a server URL');
      return;
    }
    setIsTesting(true);
    setAddError(null);
    setTestResult(null);

    const res = await serverManager.testConnection(newUrl);
    setIsTesting(false);
    setTestResult(res);
    if (!res.success) {
      setAddError(res.error || 'Connection failed');
    }
  };

  const handleSaveAndAdd = async () => {
    if (!newUrl.trim()) return;
    try {
      await serverManager.addServer(newUrl, newName);
      setNewUrl('');
      setNewName('');
      setTestResult(null);
      setShowAddForm(false);
      refreshServers();
    } catch (e: any) {
      setAddError(e?.message || 'Failed to add server');
    }
  };

  const handleSwitchServer = (server: SavedServer) => {
    if (server.id === activeServer.id) return;
    try {
      const switched = serverManager.setActiveServer(server.id);
      setActiveServer(switched);
      refreshServers();
      if (onServerSwitched) {
        onServerSwitched(switched);
      }
      onClose();
    } catch (e: any) {
      alert(`Failed to switch server: ${e?.message}`);
    }
  };

  const handleDeleteServer = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (servers.length <= 1) {
      alert('Cannot delete the last configured server.');
      return;
    }
    if (
      window.confirm(
        'Are you sure you want to remove this saved server? This only removes the local connection profile; your account and messages on the remote server remain safe.'
      )
    ) {
      serverManager.removeServer(id);
      refreshServers();
    }
  };

  const startRename = (server: SavedServer, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingServerId(server.id);
    setEditNameValue(server.name);
  };

  const saveRename = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (editNameValue.trim()) {
      serverManager.updateServer(id, { name: editNameValue.trim() });
      refreshServers();
    }
    setEditingServerId(null);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-md animate-fade-in">
      <div
        className="relative w-full max-w-2xl bg-[#1e2329] border border-gray-700/60 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700/50 bg-[#161b22]">
          <div className="flex items-center space-x-3">
            <div className="p-2 rounded-xl bg-blue-500/10 border border-blue-500/20 text-blue-400">
              <Server className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-white tracking-wide">
                Senora Server Network
              </h2>
              <p className="text-xs text-gray-400">
                Choose or add independently hosted Senora servers
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-700/50 transition"
            title="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Active Server Info Card */}
          <div className="p-4 rounded-xl bg-blue-950/20 border border-blue-500/30 flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <span className="relative flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
              </span>
              <div>
                <span className="text-xs font-semibold text-blue-400 uppercase tracking-wider">
                  Active Connected Server
                </span>
                <h3 className="text-base font-bold text-white">{activeServer.name}</h3>
                <p className="text-xs font-mono text-gray-400">{activeServer.url}</p>
              </div>
            </div>
            <div className="text-right">
              <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                <Wifi className="w-3 h-3 mr-1" />
                {activeServer.latencyMs ? `${activeServer.latencyMs} ms` : 'Connected'}
              </span>
            </div>
          </div>

          {/* Saved Servers List */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                Saved Servers ({servers.length})
              </h4>
              <button
                onClick={() => {
                  setShowAddForm(!showAddForm);
                  setAddError(null);
                  setTestResult(null);
                }}
                className="inline-flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white transition shadow-sm"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add Server</span>
              </button>
            </div>

            <div className="space-y-2">
              {servers.map((s) => {
                const isActive = s.id === activeServer.id;
                const isEditing = editingServerId === s.id;

                return (
                  <div
                    key={s.id}
                    onClick={() => handleSwitchServer(s)}
                    className={`group relative flex items-center justify-between p-3.5 rounded-xl border transition cursor-pointer ${
                      isActive
                        ? 'bg-blue-600/10 border-blue-500/40 shadow-sm'
                        : 'bg-[#161b22]/70 border-gray-700/50 hover:border-gray-600 hover:bg-[#161b22]'
                    }`}
                  >
                    <div className="flex items-center space-x-3 flex-1 min-w-0 pr-3">
                      <div
                        className={`p-2 rounded-lg ${
                          isActive
                            ? 'bg-blue-500/20 text-blue-400'
                            : 'bg-gray-800 text-gray-400'
                        }`}
                      >
                        <Globe className="w-4 h-4" />
                      </div>

                      <div className="flex-1 min-w-0">
                        {isEditing ? (
                          <div
                            className="flex items-center space-x-2"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <input
                              type="text"
                              value={editNameValue}
                              onChange={(e) => setEditNameValue(e.target.value)}
                              className="px-2 py-1 text-sm bg-gray-800 border border-blue-500 rounded text-white focus:outline-none"
                              autoFocus
                            />
                            <button
                              onClick={(e) => saveRename(s.id, e)}
                              className="p-1 text-emerald-400 hover:text-emerald-300"
                            >
                              <Check className="w-4 h-4" />
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setEditingServerId(null);
                              }}
                              className="p-1 text-gray-400 hover:text-gray-300"
                            >
                              <X className="w-4 h-4" />
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center space-x-2">
                            <span className="font-semibold text-white text-sm truncate">
                              {s.name}
                            </span>
                            {s.isDefault && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] bg-gray-700 text-gray-300">
                                Default
                              </span>
                            )}
                            {isActive && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] bg-blue-500/20 text-blue-400 border border-blue-500/30">
                                Active
                              </span>
                            )}
                          </div>
                        )}
                        <p className="text-xs text-gray-400 font-mono truncate">{s.url}</p>
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center space-x-2">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedDetailsServer(
                            selectedDetailsServer?.id === s.id ? null : s
                          );
                        }}
                        className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-700/50 transition"
                        title="Server details"
                      >
                        <Info className="w-4 h-4" />
                      </button>

                      <button
                        onClick={(e) => startRename(s, e)}
                        className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-700/50 transition"
                        title="Rename"
                      >
                        <Edit2 className="w-4 h-4" />
                      </button>

                      {!s.isDefault && servers.length > 1 && (
                        <button
                          onClick={(e) => handleDeleteServer(s.id, e)}
                          className="p-1.5 rounded-lg text-gray-400 hover:text-red-400 hover:bg-red-500/10 transition"
                          title="Remove server"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Details Panel if a server is selected */}
          {selectedDetailsServer && (
            <div className="p-4 rounded-xl bg-gray-800/40 border border-gray-700/60 space-y-3 animate-fade-in">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <Info className="w-4 h-4 text-blue-400" />
                  <h4 className="text-sm font-bold text-white">
                    {selectedDetailsServer.name} Specifications
                  </h4>
                </div>
                <button
                  onClick={() => setSelectedDetailsServer(null)}
                  className="text-xs text-gray-400 hover:text-white"
                >
                  Close
                </button>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="p-2.5 rounded-lg bg-gray-900/60 border border-gray-800">
                  <span className="text-gray-400 block mb-0.5">REST API Origin</span>
                  <span className="text-white font-mono break-all">{selectedDetailsServer.url}</span>
                </div>
                <div className="p-2.5 rounded-lg bg-gray-900/60 border border-gray-800">
                  <span className="text-gray-400 block mb-0.5">WebSocket Gateway</span>
                  <span className="text-white font-mono break-all">{selectedDetailsServer.wsUrl}</span>
                </div>
              </div>

              {selectedDetailsServer.capabilities && (
                <div>
                  <span className="text-xs font-medium text-gray-400 block mb-1.5">
                    Verified Capabilities
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {selectedDetailsServer.capabilities.encryption_modes?.map((m) => (
                      <span
                        key={m}
                        className="inline-flex items-center px-2 py-0.5 rounded text-[11px] bg-purple-500/10 text-purple-300 border border-purple-500/20"
                      >
                        <Shield className="w-3 h-3 mr-1" />
                        {m}
                      </span>
                    ))}
                    {selectedDetailsServer.capabilities.calling?.map((c) => (
                      <span
                        key={c}
                        className="inline-flex items-center px-2 py-0.5 rounded text-[11px] bg-blue-500/10 text-blue-300 border border-blue-500/20"
                      >
                        <Phone className="w-3 h-3 mr-1" />
                        {c}
                      </span>
                    ))}
                    {selectedDetailsServer.capabilities.max_upload_bytes && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">
                        <HardDrive className="w-3 h-3 mr-1" />
                        Max {Math.round(selectedDetailsServer.capabilities.max_upload_bytes / (1024 * 1024))}MB
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Add Server Form */}
          {showAddForm && (
            <div className="p-4 rounded-xl bg-[#161b22] border border-blue-500/30 space-y-4 animate-fade-in">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-bold text-white flex items-center space-x-2">
                  <Server className="w-4 h-4 text-blue-400" />
                  <span>Connect to Self-Hosted Senora Server</span>
                </h4>
                <button
                  onClick={() => setShowAddForm(false)}
                  className="text-xs text-gray-400 hover:text-white"
                >
                  Cancel
                </button>
              </div>

              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-gray-300 mb-1">
                    Server Address (HTTPS required for remote)
                  </label>
                  <input
                    type="url"
                    value={newUrl}
                    onChange={(e) => setNewUrl(e.target.value)}
                    placeholder="https://chat.mycompany.com or http://localhost:8080"
                    className="w-full px-3 py-2 text-sm bg-gray-900 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 font-mono"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-300 mb-1">
                    Display Name (Optional)
                  </label>
                  <input
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="e.g. My Private Node"
                    className="w-full px-3 py-2 text-sm bg-gray-900 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                  />
                </div>

                {addError && (
                  <div className="p-2.5 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-400 flex items-center space-x-2">
                    <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                    <span>{addError}</span>
                  </div>
                )}

                {testResult && testResult.success && (
                  <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-300 space-y-1.5">
                    <div className="flex items-center justify-between font-semibold">
                      <span className="flex items-center space-x-1">
                        <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                        <span>Connected successfully ({testResult.latencyMs} ms)</span>
                      </span>
                      <span>v{testResult.discovery?.version || '1.0'}</span>
                    </div>
                    {testResult.discovery?.capabilities && (
                      <div className="text-[11px] text-gray-400">
                        Capabilities verified: E2EE Signal, WebRTC Calling, Channels, Outbox Replay
                      </div>
                    )}
                  </div>
                )}

                <div className="flex items-center justify-end space-x-2 pt-2">
                  <button
                    onClick={handleTestConnection}
                    disabled={isTesting || !newUrl.trim()}
                    className="px-3.5 py-2 rounded-lg text-xs font-semibold bg-gray-800 hover:bg-gray-700 text-gray-200 transition border border-gray-700 flex items-center space-x-1.5 disabled:opacity-50"
                  >
                    {isTesting ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        <span>Testing...</span>
                      </>
                    ) : (
                      <>
                        <Wifi className="w-3.5 h-3.5" />
                        <span>Test Connection</span>
                      </>
                    )}
                  </button>

                  <button
                    onClick={handleSaveAndAdd}
                    disabled={!newUrl.trim() || isTesting}
                    className="px-4 py-2 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white transition disabled:opacity-50"
                  >
                    Save Server
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Self-Hosting Instructions Accordion */}
          <div className="border border-gray-800 rounded-xl overflow-hidden bg-[#161b22]/40">
            <button
              onClick={() => setShowInstructions(!showInstructions)}
              className="w-full flex items-center justify-between p-3.5 text-xs font-medium text-gray-300 hover:text-white transition"
            >
              <div className="flex items-center space-x-2">
                <Info className="w-4 h-4 text-blue-400" />
                <span>How to host your own Senora messaging server</span>
              </div>
              {showInstructions ? (
                <ChevronDown className="w-4 h-4" />
              ) : (
                <ChevronRight className="w-4 h-4" />
              )}
            </button>

            {showInstructions && (
              <div className="p-4 border-t border-gray-800 text-xs text-gray-400 space-y-2 bg-gray-900/40">
                <p>
                  Senora is 100% self-hosted with complete data ownership. To deploy an independent
                  server node:
                </p>
                <ol className="list-decimal list-inside space-y-1 pl-1">
                  <li>Deploy the backend using Docker Compose in <code className="text-gray-200">deployments/compose/docker-compose.yml</code>.</li>
                  <li>Configure your domain name and automatic TLS with Caddy or Nginx.</li>
                  <li>Ensure ports 80 and 443 are open for HTTP and WebSocket connections.</li>
                  <li>Enter your server URL above and click <strong>Test Connection</strong>.</li>
                </ol>
                <p className="text-[11px] text-gray-500 pt-1">
                  All account credentials, encryption keys, and message caches remain strictly
                  isolated to each server.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-gray-700/50 bg-[#161b22] flex items-center justify-between text-xs text-gray-400">
          <span>Client: Senora Multi-Platform v1.0.0</span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-white font-medium transition"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
