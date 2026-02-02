/**
 * SourceBrowser - Browse and load textures from the sources folder
 */

import { useState, useEffect } from 'react';

interface SourceBrowserProps {
  onLoadFolder: (folderName: string, files: { name: string; url: string }[]) => void;
  onClose: () => void;
}

export function SourceBrowser({ onLoadFolder, onClose }: SourceBrowserProps) {
  const [folders, setFolders] = useState<string[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');

  // Load folders list
  useEffect(() => {
    fetch('/api/sources')
      .then(res => res.json())
      .then(data => {
        setFolders(data);
        setLoading(false);
      })
      .catch(() => {
        setLoading(false);
      });
  }, []);

  // Load files when folder selected
  useEffect(() => {
    if (!selectedFolder) {
      setFiles([]);
      return;
    }

    fetch(`/api/sources/${selectedFolder}`)
      .then(res => res.json())
      .then(data => setFiles(data))
      .catch(() => setFiles([]));
  }, [selectedFolder]);

  const handleLoadFolder = () => {
    if (!selectedFolder || files.length === 0) return;

    const fileData = files.map(name => ({
      name,
      url: `/sources/${selectedFolder}/${name}`,
    }));

    onLoadFolder(selectedFolder, fileData);
  };

  // Filter folders for leaf-related textures
  const filteredFolders = folders.filter(f => 
    f.toLowerCase().includes(filter.toLowerCase())
  );

  // Highlight leaf-related folders
  const leafFolders = filteredFolders.filter(f => 
    /leaf|leaves|foliage|hedge|ivy|palm|fern|bush/i.test(f)
  );
  const otherFolders = filteredFolders.filter(f => 
    !/leaf|leaves|foliage|hedge|ivy|palm|fern|bush/i.test(f)
  );

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg w-[600px] max-h-[80vh] flex flex-col">
        <div className="p-4 border-b border-gray-700 flex justify-between items-center">
          <h2 className="text-lg font-semibold">Load from Sources</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white">✕</button>
        </div>

        <div className="p-4 border-b border-gray-700">
          <input
            type="text"
            placeholder="Filter folders..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-full px-3 py-2 bg-gray-700 rounded text-sm"
          />
        </div>

        <div className="flex-1 overflow-auto p-4 grid grid-cols-2 gap-4">
          {/* Folder list */}
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-gray-400 mb-2">Folders</h3>
            {loading ? (
              <p className="text-gray-500">Loading...</p>
            ) : (
              <>
                {leafFolders.length > 0 && (
                  <>
                    <p className="text-xs text-green-500 mt-2">Leaf textures:</p>
                    {leafFolders.map(folder => (
                      <button
                        key={folder}
                        onClick={() => setSelectedFolder(folder)}
                        className={`block w-full text-left px-2 py-1 rounded text-sm ${
                          selectedFolder === folder
                            ? 'bg-green-600 text-white'
                            : 'hover:bg-gray-700 text-green-400'
                        }`}
                      >
                        📁 {folder}
                      </button>
                    ))}
                  </>
                )}
                {otherFolders.length > 0 && (
                  <>
                    <p className="text-xs text-gray-500 mt-2">Other:</p>
                    {otherFolders.map(folder => (
                      <button
                        key={folder}
                        onClick={() => setSelectedFolder(folder)}
                        className={`block w-full text-left px-2 py-1 rounded text-sm ${
                          selectedFolder === folder
                            ? 'bg-blue-600 text-white'
                            : 'hover:bg-gray-700 text-gray-300'
                        }`}
                      >
                        📁 {folder}
                      </button>
                    ))}
                  </>
                )}
              </>
            )}
          </div>

          {/* File list */}
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-gray-400 mb-2">
              Files {selectedFolder && `(${files.length})`}
            </h3>
            {selectedFolder ? (
              files.length > 0 ? (
                <div className="space-y-1">
                  {files.map(file => (
                    <div
                      key={file}
                      className="px-2 py-1 text-sm text-gray-300 truncate"
                      title={file}
                    >
                      🖼️ {file}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-gray-500 text-sm">No image files found</p>
              )
            ) : (
              <p className="text-gray-500 text-sm">Select a folder</p>
            )}
          </div>
        </div>

        <div className="p-4 border-t border-gray-700 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded"
          >
            Cancel
          </button>
          <button
            onClick={handleLoadFolder}
            disabled={!selectedFolder || files.length === 0}
            className="px-4 py-2 bg-green-600 hover:bg-green-500 disabled:bg-gray-600 disabled:cursor-not-allowed rounded"
          >
            Load {selectedFolder || 'Folder'}
          </button>
        </div>
      </div>
    </div>
  );
}
