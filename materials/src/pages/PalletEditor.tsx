import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { MaterialPreview } from '../components/MaterialPreview';

interface MapConfig {
  path?: string;
  channel?: string;
  color?: { r: number; g: number; b: number; alpha?: number };
}

interface MaterialConfig {
  type: 'solid' | 'liquid' | 'transparent';
  enabled?: boolean;
  index?: number;
  albedo?: MapConfig;
  normal?: MapConfig;
  ao?: MapConfig;
  roughness?: MapConfig;
  metalness?: MapConfig;
}

interface MaterialsConfig {
  textureSize: { low: number; high: number };
  materials: Record<string, MaterialConfig>;
}

interface MaterialInfo {
  name: string;
  config: MaterialConfig;
  hasSourceFolder: boolean;
  isUnconfigured: boolean;
  previewImage?: string;
}

export function PalletEditor() {
  const [materialsConfig, setMaterialsConfig] = useState<MaterialsConfig | null>(null);
  const [sourceFolders, setSourceFolders] = useState<string[]>([]);
  const [sourceFiles, setSourceFiles] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState<'all' | 'enabled' | 'disabled' | 'unconfigured'>('all');
  const [search, setSearch] = useState('');
  const [hasChanges, setHasChanges] = useState(false);
  const [selectedMaterial, setSelectedMaterial] = useState<string | null>(null);

  // Load all data
  useEffect(() => {
    async function loadData() {
      try {
        const [configRes, foldersRes] = await Promise.all([
          fetch('/api/materials-config'),
          fetch('/api/sources'),
        ]);

        const configData = await configRes.json();
        const foldersData = await foldersRes.json();

        setMaterialsConfig(configData);
        setSourceFolders(foldersData);

        // Load preview images for each folder
        const files: Record<string, string[]> = {};
        await Promise.all(
          foldersData.map(async (folder: string) => {
            const res = await fetch(`/api/sources/${folder}`);
            files[folder] = await res.json();
          })
        );
        setSourceFiles(files);
      } catch (err) {
        console.error('Failed to load data:', err);
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, []);

  // Compute unified material list (configured + unconfigured source folders)
  const materials = useMemo<MaterialInfo[]>(() => {
    if (!materialsConfig) return [];

    const result: MaterialInfo[] = [];

    // Add configured materials
    Object.entries(materialsConfig.materials).forEach(([name, config]) => {
      const files = sourceFiles[name] || [];
      const colorFile = files.find(
        (f) => /color|albedo|diff|basecolor/i.test(f) && /\.(png|jpg|jpeg|webp)$/i.test(f)
      );

      result.push({
        name,
        config,
        hasSourceFolder: sourceFolders.includes(name),
        isUnconfigured: false,
        previewImage: colorFile ? `/sources/${name}/${colorFile}` : undefined,
      });
    });

    // Add unconfigured source folders with auto-detected config
    sourceFolders.forEach((folderName) => {
      if (!materialsConfig.materials[folderName]) {
        const files = sourceFiles[folderName] || [];
        const colorFile = files.find(
          (f) => /color|albedo|diff|basecolor/i.test(f) && /\.(png|jpg|jpeg|webp)$/i.test(f)
        );

        // Auto-detect config from source files
        const autoDetectedConfig = autoDetectMaterialConfig(folderName, files);

        result.push({
          name: folderName,
          config: autoDetectedConfig,
          hasSourceFolder: true,
          isUnconfigured: true,
          previewImage: colorFile ? `/sources/${folderName}/${colorFile}` : undefined,
        });
      }
    });

    return result.sort((a, b) => {
      const aEnabled = a.config.enabled !== false;
      const bEnabled = b.config.enabled !== false;

      // Enabled materials come first, sorted by index
      if (aEnabled && bEnabled) {
        return (a.config.index ?? 9999) - (b.config.index ?? 9999);
      }
      if (aEnabled) return -1;
      if (bEnabled) return 1;

      // Unconfigured materials come last
      if (a.isUnconfigured !== b.isUnconfigured) {
        return a.isUnconfigured ? 1 : -1;
      }

      // Non-enabled materials sorted alphabetically
      return a.name.localeCompare(b.name);
    });
  }, [materialsConfig, sourceFolders, sourceFiles]);

  // Count unconfigured materials
  const unconfiguredCount = useMemo(() => {
    return materials.filter(m => m.isUnconfigured).length;
  }, [materials]);

  // Filtered materials
  const filteredMaterials = useMemo(() => {
    return materials.filter((m) => {
      // Search filter
      if (search && !m.name.toLowerCase().includes(search.toLowerCase())) {
        return false;
      }

      // Status filter
      const isEnabled = m.config.enabled !== false;
      switch (filter) {
        case 'enabled':
          return isEnabled;
        case 'disabled':
          return !isEnabled && !m.isUnconfigured;
        case 'unconfigured':
          return m.isUnconfigured;
        default:
          return true;
      }
    });
  }, [materials, filter, search]);

  // Get enabled materials count and next available index
  const enabledMaterials = useMemo(() => {
    return materials.filter((m) => m.config.enabled !== false);
  }, [materials]);

  const nextIndex = useMemo(() => {
    if (enabledMaterials.length === 0) return 0;
    const maxIndex = Math.max(...enabledMaterials.map((m) => m.config.index ?? 0));
    return maxIndex + 1;
  }, [enabledMaterials]);

  // Toggle material enabled state
  const toggleMaterial = (name: string) => {
    if (!materialsConfig) return;

    // If material doesn't exist in config yet (unconfigured), get auto-detected config
    let material = materialsConfig.materials[name];
    if (!material) {
      const materialInfo = materials.find(m => m.name === name);
      if (!materialInfo) return;
      material = materialInfo.config;
    }
    const isCurrentlyEnabled = material.enabled !== false;

    const updatedMaterial = {
      ...material,
      enabled: !isCurrentlyEnabled,
      index: !isCurrentlyEnabled ? nextIndex : undefined,
    };

    // If disabling, we need to reindex all materials after this one
    let newMaterials = { ...materialsConfig.materials, [name]: updatedMaterial };

    if (isCurrentlyEnabled) {
      // Reindex materials after the disabled one
      const disabledIndex = material.index ?? 9999;
      Object.entries(newMaterials).forEach(([matName, mat]) => {
        if (mat.enabled !== false && mat.index !== undefined && mat.index > disabledIndex) {
          newMaterials[matName] = { ...mat, index: mat.index - 1 };
        }
      });
    }

    setMaterialsConfig({ ...materialsConfig, materials: newMaterials });
    setHasChanges(true);
  };

  // Set material to specific index, swapping with existing material at that position
  const setMaterialIndex = (name: string, targetIndex: number) => {
    if (!materialsConfig) return;

    const currentMaterial = materialsConfig.materials[name];
    const currentIndex = currentMaterial.index;
    if (currentIndex === undefined || currentIndex === targetIndex) return;
    if (targetIndex < 0 || targetIndex >= enabledMaterials.length) return;

    // Find material at target index
    const targetMaterialEntry = Object.entries(materialsConfig.materials).find(
      ([_, mat]) => mat.enabled !== false && mat.index === targetIndex
    );

    const newMaterials = { ...materialsConfig.materials };

    // Swap indices
    newMaterials[name] = { ...currentMaterial, index: targetIndex };
    if (targetMaterialEntry) {
      newMaterials[targetMaterialEntry[0]] = { ...targetMaterialEntry[1], index: currentIndex };
    }

    setMaterialsConfig({ ...materialsConfig, materials: newMaterials });
    setHasChanges(true);
  };

  // Move material up/down
  const moveMaterial = (name: string, direction: 'up' | 'down') => {
    if (!materialsConfig) return;

    const material = materialsConfig.materials[name];
    const currentIndex = material.index;
    if (currentIndex === undefined) return;

    const newIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    setMaterialIndex(name, newIndex);
  };

  // Update material configuration
  const updateMaterialConfig = (name: string, updates: Partial<MaterialConfig>) => {
    if (!materialsConfig) return;

    // If material doesn't exist in config yet (unconfigured), get auto-detected config from materials list
    const existingConfig = materialsConfig.materials[name] ?? 
      materials.find(m => m.name === name)?.config ?? 
      { type: 'solid' as const, enabled: false };

    const newMaterials = {
      ...materialsConfig.materials,
      [name]: { ...existingConfig, ...updates },
    };

    setMaterialsConfig({ ...materialsConfig, materials: newMaterials });
    setHasChanges(true);
  };

  // Add unconfigured material to config (used when selecting an unconfigured material)
  const addUnconfiguredMaterial = (name: string) => {
    if (!materialsConfig || materialsConfig.materials[name]) return;

    const materialInfo = materials.find(m => m.name === name);
    if (!materialInfo) return;

    const newMaterials = {
      ...materialsConfig.materials,
      [name]: { ...materialInfo.config },
    };

    setMaterialsConfig({ ...materialsConfig, materials: newMaterials });
    setHasChanges(true);
  };

  // Handle material selection
  const handleSelectMaterial = (name: string) => {
    if (selectedMaterial === name) {
      setSelectedMaterial(null);
    } else {
      // If it's an unconfigured material, add it to config first
      const materialInfo = materials.find(m => m.name === name);
      if (materialInfo?.isUnconfigured) {
        addUnconfiguredMaterial(name);
      }
      setSelectedMaterial(name);
    }
  };

  // Save changes
  const saveConfig = async () => {
    if (!materialsConfig) return;

    setSaving(true);
    try {
      const res = await fetch('/api/materials-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(materialsConfig),
      });

      if (res.ok) {
        setHasChanges(false);
      } else {
        console.error('Failed to save config');
      }
    } catch (err) {
      console.error('Failed to save config:', err);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
        <div className="text-xl">Loading...</div>
      </div>
    );
  }

  const enabledCount = enabledMaterials.length;
  const totalCount = materials.length;

  return (
    <div className="h-screen flex flex-col bg-gray-900 text-white">
      {/* Header */}
      <header className="bg-gray-800 border-b border-gray-700 px-6 py-4 flex-shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link to="/" className="text-gray-400 hover:text-white">
              ← Back
            </Link>
            <div>
              <h1 className="text-2xl font-bold">Pallet Editor</h1>
              <p className="text-gray-400 text-sm">
                {enabledCount} enabled / {totalCount} total materials
              </p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            {hasChanges && <span className="text-yellow-400 text-sm">Unsaved changes</span>}
            <button
              onClick={saveConfig}
              disabled={saving || !hasChanges}
              className={`px-4 py-2 rounded font-medium ${
                hasChanges
                  ? 'bg-blue-600 hover:bg-blue-700 text-white'
                  : 'bg-gray-700 text-gray-500 cursor-not-allowed'
              }`}
            >
              {saving ? 'Saving...' : 'Save Config'}
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-4 mt-4">
          <input
            type="text"
            placeholder="Search materials..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white placeholder-gray-400 w-64"
          />

          <div className="flex gap-2">
            {(['all', 'enabled', 'disabled', 'unconfigured'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-1 rounded text-sm ${
                  filter === f
                    ? f === 'unconfigured' ? 'bg-yellow-600 text-white' : 'bg-blue-600 text-white'
                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                }`}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
                {f === 'enabled' && ` (${enabledCount})`}
                {f === 'disabled' && ` (${totalCount - enabledCount - unconfiguredCount})`}
                {f === 'unconfigured' && ` (${unconfiguredCount})`}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* Material Grid */}
      <main className="flex-1 flex gap-6 overflow-hidden">
        <div className={`${selectedMaterial ? 'flex-1' : 'w-full'} overflow-y-auto p-6`}>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
            {filteredMaterials.map((material) => (
              <MaterialCard
                key={material.name}
                material={material}
                maxIndex={enabledMaterials.length - 1}
                isSelected={selectedMaterial === material.name}
                onSelect={() => handleSelectMaterial(material.name)}
                onToggle={() => toggleMaterial(material.name)}
                onMoveUp={() => moveMaterial(material.name, 'up')}
                onMoveDown={() => moveMaterial(material.name, 'down')}
                onSetIndex={(newIndex) => setMaterialIndex(material.name, newIndex)}
                canMoveUp={material.config.enabled !== false && (material.config.index ?? 0) > 0}
                canMoveDown={
                  material.config.enabled !== false &&
                  (material.config.index ?? 0) < enabledMaterials.length - 1
                }
              />
            ))}
          </div>

          {filteredMaterials.length === 0 && (
            <div className="text-center text-gray-500 py-12">
              No materials match the current filters.
            </div>
          )}
        </div>

        {/* Material Config Panel */}
        {selectedMaterial && (
          <MaterialConfigPanel
            name={selectedMaterial}
            config={materialsConfig?.materials[selectedMaterial] ?? 
              materials.find(m => m.name === selectedMaterial)?.config ?? 
              { type: 'solid', enabled: false }}
            files={sourceFiles[selectedMaterial] || []}
            hasSourceFolder={sourceFolders.includes(selectedMaterial)}
            onUpdateConfig={(updates) => updateMaterialConfig(selectedMaterial, updates)}
            onClose={() => setSelectedMaterial(null)}
          />
        )}
      </main>
    </div>
  );
}

// Map type labels and auto-detection patterns
const MAP_TYPES = ['albedo', 'normal', 'ao', 'roughness', 'metalness'] as const;
type MapType = typeof MAP_TYPES[number];

const MAP_LABELS: Record<MapType, string> = {
  albedo: 'Albedo/Color',
  normal: 'Normal',
  ao: 'Ambient Occlusion',
  roughness: 'Roughness',
  metalness: 'Metalness',
};

const MAP_PATTERNS: Record<MapType, RegExp> = {
  albedo: /color|albedo|diff|basecolor|_col_/i,
  normal: /normal|nrm|_nor_|normalgl/i,
  ao: /ao|ambient|occlusion|_ao_/i,
  roughness: /rough|_rgh_|roughness/i,
  metalness: /metal|_met_|metallic|metalness/i,
};

// Auto-detect material config from source files
function autoDetectMaterialConfig(folderName: string, files: string[]): MaterialConfig {
  const config: MaterialConfig = {
    type: 'solid',
    enabled: false,
  };

  for (const file of files) {
    const detectedType = detectMapType(file);
    if (detectedType && !config[detectedType]?.path) {
      const channel = detectChannel(file, detectedType);
      config[detectedType] = {
        path: `${folderName}/${file}`,
        ...(channel ? { channel } : {}),
      };
    }
  }

  return config;
}

// Detect map type from filename
function detectMapType(filename: string): MapType | null {
  for (const mapType of MAP_TYPES) {
    if (MAP_PATTERNS[mapType].test(filename)) {
      return mapType;
    }
  }
  return null;
}

// Detect channel from ARM/ORM packed textures
function detectChannel(filename: string, mapType: MapType): string | undefined {
  if (/arm|orm/i.test(filename)) {
    if (mapType === 'ao') return 'r';
    if (mapType === 'roughness') return 'g';
    if (mapType === 'metalness') return 'b';
  }
  return undefined;
}

interface MaterialConfigPanelProps {
  name: string;
  config: MaterialConfig;
  files: string[];
  hasSourceFolder: boolean;
  onUpdateConfig: (updates: Partial<MaterialConfig>) => void;
  onClose: () => void;
}

const CHANNELS = ['rgba', 'r', 'g', 'b', 'a'] as const;

function MaterialConfigPanel({
  name,
  config,
  files,
  hasSourceFolder,
  onUpdateConfig,
  onClose,
}: MaterialConfigPanelProps) {
  const [selectedLayer, setSelectedLayer] = useState<MapType>('albedo');
  const [showPreview, setShowPreview] = useState(true);

  // Get the currently assigned file for each map type
  const getAssignedFile = (mapType: MapType): string | undefined => {
    const mapConfig = config[mapType];
    if (!mapConfig?.path) return undefined;
    const parts = mapConfig.path.split('/');
    return parts[parts.length - 1];
  };

  // Get current channel for a map type
  const getChannel = (mapType: MapType): string => {
    return config[mapType]?.channel || 'rgba';
  };

  // Set a file for the selected layer
  const selectFileForLayer = (filename: string) => {
    const currentConfig = config[selectedLayer] || {};
    const detectedChannel = detectChannel(filename, selectedLayer);
    onUpdateConfig({
      [selectedLayer]: {
        ...currentConfig,
        path: `${name}/${filename}`,
        ...(detectedChannel && !currentConfig.channel ? { channel: detectedChannel } : {}),
      },
    });
  };

  // Clear the selected layer
  const clearLayer = () => {
    onUpdateConfig({ [selectedLayer]: {} });
  };

  // Set channel for selected layer
  const setChannel = (channel: string) => {
    const currentConfig = config[selectedLayer] || {};
    if (channel === 'rgba') {
      // Remove channel property for rgba (default)
      const { channel: _, ...rest } = currentConfig as MapConfig & { channel?: string };
      onUpdateConfig({ [selectedLayer]: rest });
    } else {
      onUpdateConfig({
        [selectedLayer]: { ...currentConfig, channel },
      });
    }
  };

  // Auto-detect and assign all files
  const autoDetectAll = () => {
    const updates: Partial<MaterialConfig> = {};
    for (const file of files) {
      const detectedType = detectMapType(file);
      if (detectedType && !updates[detectedType]) {
        const channel = detectChannel(file, detectedType);
        updates[detectedType] = {
          path: `${name}/${file}`,
          ...(channel ? { channel } : {}),
        };
      }
    }
    onUpdateConfig(updates);
  };

  const currentFile = getAssignedFile(selectedLayer);
  const currentChannel = getChannel(selectedLayer);

  return (
    <div className="w-80 bg-gray-800 border-l border-gray-700 flex-shrink-0 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
        <h3 className="text-lg font-semibold truncate">{name}</h3>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-white text-xl leading-none ml-2"
        >
          ×
        </button>
      </div>

      {/* 3D Preview */}
      <div className="p-3 border-b border-gray-700">
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs text-gray-400">3D Preview</label>
          <button
            onClick={() => setShowPreview(!showPreview)}
            className="text-xs text-gray-400 hover:text-white"
          >
            {showPreview ? 'Hide' : 'Show'}
          </button>
        </div>
        {showPreview && (
          <MaterialPreview
            materialName={name}
            config={config}
            height={200}
          />
        )}
      </div>

      {/* Layer Selection + Channel */}
      <div className="p-3 border-b border-gray-700 space-y-3">
        {/* Material Type */}
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-400 w-12">Type</label>
          <select
            value={config.type}
            onChange={(e) => onUpdateConfig({ type: e.target.value as 'solid' | 'liquid' | 'transparent' })}
            className="flex-1 px-2 py-1 bg-gray-700 border border-gray-600 rounded text-sm text-white"
          >
            <option value="solid">Solid</option>
            <option value="liquid">Liquid</option>
            <option value="transparent">Transparent</option>
          </select>
        </div>

        {/* Layer Tabs */}
        <div>
          <label className="text-xs text-gray-400 mb-1 block">Layer</label>
          <div className="space-y-1">
            {MAP_TYPES.map((mapType) => {
              const file = getAssignedFile(mapType);
              const channel = config[mapType]?.channel;
              return (
                <button
                  key={mapType}
                  onClick={() => setSelectedLayer(mapType)}
                  className={`w-full px-2 py-1.5 text-xs rounded transition-colors text-left flex items-center gap-2 ${
                    selectedLayer === mapType
                      ? 'bg-purple-600 text-white'
                      : file
                        ? 'bg-green-700/80 text-white hover:bg-green-600'
                        : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                >
                  <span className="font-medium w-16 flex-shrink-0">{MAP_LABELS[mapType].split('/')[0]}</span>
                  {file ? (
                    <span className="truncate text-[10px] opacity-80 flex-1">
                      {file}{channel ? ` [${channel.toUpperCase()}]` : ''}
                    </span>
                  ) : (
                    <span className="text-[10px] opacity-50 italic">none</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Channel Selection */}
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-400 w-12">Channel</label>
          <div className="flex gap-1 flex-1">
            {CHANNELS.map((ch) => (
              <button
                key={ch}
                onClick={() => setChannel(ch)}
                className={`flex-1 px-2 py-1 text-xs rounded uppercase ${
                  currentChannel === ch
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                }`}
              >
                {ch}
              </button>
            ))}
          </div>
        </div>

        {/* Current Assignment */}
        <div className="flex items-center gap-2">
          <div className="flex-1 text-xs text-gray-400 truncate">
            {currentFile ? (
              <span className="text-green-400">✓ {currentFile}</span>
            ) : (
              <span className="text-gray-500">No file assigned</span>
            )}
          </div>
          {currentFile && (
            <button
              onClick={clearLayer}
              className="text-xs text-red-400 hover:text-red-300"
            >
              Clear
            </button>
          )}
        </div>

        {/* Auto-detect */}
        {hasSourceFolder && files.length > 0 && (
          <button
            onClick={autoDetectAll}
            className="w-full px-3 py-1.5 bg-purple-600 hover:bg-purple-700 text-white rounded text-xs font-medium"
          >
            🔍 Auto-Detect All
          </button>
        )}
      </div>

      {/* Source Files Grid */}
      <div className="flex-1 overflow-y-auto p-3">
        {!hasSourceFolder ? (
          <div className="text-center text-yellow-400 text-sm py-4">
            ⚠️ No source folder
          </div>
        ) : files.length === 0 ? (
          <div className="text-center text-gray-500 text-sm py-4">
            No files found
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {files.map((file) => {
              const isSelected = currentFile === file;
              
              // Find all layers that use this file
              const assignedLayers = MAP_TYPES.filter((t) => getAssignedFile(t) === file);
              const isAssignedToCurrentLayer = assignedLayers.includes(selectedLayer);
              const isAssignedElsewhere = assignedLayers.length > 0 && !isAssignedToCurrentLayer;

              return (
                <button
                  key={file}
                  onClick={() => selectFileForLayer(file)}
                  className={`relative aspect-square rounded overflow-hidden border-2 transition-all ${
                    isSelected
                      ? 'border-purple-500 ring-2 ring-purple-500/50'
                      : isAssignedElsewhere
                        ? 'border-green-600/50'
                        : 'border-gray-600 hover:border-gray-500'
                  }`}
                  title={file}
                >
                  <img
                    src={`/sources/${name}/${file}`}
                    alt={file}
                    className="w-full h-full object-cover"
                  />
                  {/* Show all assigned layers with channels */}
                  {assignedLayers.length > 0 && (
                    <div className="absolute bottom-0 left-0 right-0 bg-black/80 text-[9px] px-1 py-0.5 flex flex-wrap gap-x-1">
                      {assignedLayers.map((layer) => {
                        const ch = config[layer]?.channel;
                        const isCurrentLayer = layer === selectedLayer;
                        return (
                          <span
                            key={layer}
                            className={isCurrentLayer ? 'text-purple-300 font-medium' : 'text-green-300'}
                          >
                            {MAP_LABELS[layer].split('/')[0]}{ch ? `(${ch})` : ''}
                          </span>
                        );
                      })}
                    </div>
                  )}
                  {/* Selected indicator */}
                  {isSelected && (
                    <div className="absolute top-1 right-1 w-4 h-4 bg-purple-500 rounded-full flex items-center justify-center text-white text-xs">
                      ✓
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
interface MaterialCardProps {
  material: MaterialInfo;
  maxIndex: number;
  isSelected: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onSetIndex: (index: number) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}

function MaterialCard({
  material,
  maxIndex,
  isSelected,
  onSelect,
  onToggle,
  onMoveUp,
  onMoveDown,
  onSetIndex,
  canMoveUp,
  canMoveDown,
}: MaterialCardProps) {
  const [isEditingIndex, setIsEditingIndex] = useState(false);
  const [editValue, setEditValue] = useState('');

  const isEnabled = material.config.enabled !== false;
  const index = material.config.index;

  const handleIndexClick = () => {
    if (index !== undefined) {
      setEditValue(String(index));
      setIsEditingIndex(true);
    }
  };

  const handleIndexSubmit = () => {
    const newIndex = parseInt(editValue, 10);
    if (!isNaN(newIndex) && newIndex >= 0 && newIndex <= maxIndex) {
      onSetIndex(newIndex);
    }
    setIsEditingIndex(false);
  };

  const handleIndexKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleIndexSubmit();
    } else if (e.key === 'Escape') {
      setIsEditingIndex(false);
    }
  };

  const typeColors = {
    solid: 'bg-gray-600',
    liquid: 'bg-blue-600',
    transparent: 'bg-green-600',
  };

  return (
    <div
      onClick={onSelect}
      className={`relative rounded-lg overflow-hidden border-2 transition-all cursor-pointer ${
        isSelected
          ? 'border-purple-500 ring-2 ring-purple-500/50 bg-gray-800'
          : isEnabled
            ? 'border-blue-500 bg-gray-800 hover:border-blue-400'
            : 'border-gray-600 bg-gray-800/50 hover:border-gray-500'
      }`}
    >
      {/* Preview Image */}
      <div className="aspect-square bg-gray-700 relative">
        {material.previewImage ? (
          <img
            src={material.previewImage}
            alt={material.name}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-500 text-xs">
            No preview
          </div>
        )}

        {/* Index badge - click to edit */}
        {isEnabled && index !== undefined && (
          isEditingIndex ? (
            <input
              type="number"
              min={0}
              max={maxIndex}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={handleIndexSubmit}
              onKeyDown={handleIndexKeyDown}
              onClick={(e) => e.stopPropagation()}
              autoFocus
              className="absolute top-1 left-1 w-12 bg-black/90 text-white text-xs px-1.5 py-0.5 rounded border border-blue-500 outline-none"
            />
          ) : (
            <button
              onClick={(e) => { e.stopPropagation(); handleIndexClick(); }}
              className="absolute top-1 left-1 bg-black/70 hover:bg-blue-600 text-white text-xs px-1.5 py-0.5 rounded cursor-pointer transition-colors"
              title="Click to change index"
            >
              #{index}
            </button>
          )
        )}

        {/* Type badge */}
        <div
          className={`absolute top-1 right-1 ${typeColors[material.config.type]} text-white text-xs px-1.5 py-0.5 rounded`}
        >
          {material.config.type}
        </div>

        {/* Status indicators */}
        <div className="absolute bottom-1 left-1 flex gap-1">
          {!material.hasSourceFolder && (
            <span className="bg-red-600 text-white text-xs px-1 py-0.5 rounded" title="No source folder">
              ?
            </span>
          )}
          {material.isUnconfigured && (
            <span className="bg-yellow-600 text-white text-xs px-1 py-0.5 rounded" title="New - not in config">
              NEW
            </span>
          )}
        </div>
      </div>

      {/* Info */}
      <div className="p-2">
        <div className="text-sm font-medium truncate" title={material.name}>
          {material.name}
        </div>

        <div className="flex items-center gap-1 mt-2">
          <button
            onClick={(e) => { e.stopPropagation(); onToggle(); }}
            className={`flex-1 px-2 py-1 text-xs rounded transition-colors ${
              isEnabled
                ? 'bg-blue-600 hover:bg-blue-700 text-white'
                : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
            }`}
          >
            {isEnabled ? 'Enabled' : 'Disabled'}
          </button>

          {isEnabled && (
            <>
              <button
                onClick={(e) => { e.stopPropagation(); onMoveUp(); }}
                disabled={!canMoveUp}
                className={`px-1.5 py-1 text-xs rounded ${
                  canMoveUp
                    ? 'bg-gray-700 hover:bg-gray-600 text-white'
                    : 'bg-gray-700/50 text-gray-500 cursor-not-allowed'
                }`}
              >
                ↑
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onMoveDown(); }}
                disabled={!canMoveDown}
                className={`px-1.5 py-1 text-xs rounded ${
                  canMoveDown
                    ? 'bg-gray-700 hover:bg-gray-600 text-white'
                    : 'bg-gray-700/50 text-gray-500 cursor-not-allowed'
                }`}
              >
                ↓
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
