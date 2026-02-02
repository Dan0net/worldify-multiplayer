import { Link } from 'react-router-dom';

export function Home() {
  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <header className="bg-gray-800 border-b border-gray-700 px-6 py-4">
        <h1 className="text-2xl font-bold">Worldify Materials</h1>
        <p className="text-gray-400 mt-1">Texture tools and pallet configuration</p>
      </header>

      <main className="p-6">
        <div className="grid gap-4 max-w-4xl">
          <Link
            to="/materials"
            className="block p-6 bg-gray-800 rounded-lg border border-gray-700 hover:border-blue-500 transition-colors"
          >
            <h2 className="text-xl font-semibold mb-2">Material Viewer</h2>
            <p className="text-gray-400">
              Inspect all materials with their texture layers (albedo, normal, AO, roughness, metalness)
              at both low and high resolutions.
            </p>
          </Link>

          <Link
            to="/leaf-editor"
            className="block p-6 bg-gray-800 rounded-lg border border-gray-700 hover:border-green-500 transition-colors"
          >
            <h2 className="text-xl font-semibold mb-2">Leaf Texture Editor</h2>
            <p className="text-gray-400">
              Extract individual leaves from atlas textures and arrange them into tileable PBR texture sets.
              Supports Color, Opacity, Normal, Roughness, and Displacement layers.
            </p>
          </Link>

          <Link
            to="/pallet"
            className="block p-6 bg-gray-800 rounded-lg border border-gray-700 hover:border-purple-500 transition-colors"
          >
            <h2 className="text-xl font-semibold mb-2">Pallet Editor</h2>
            <p className="text-gray-400">
              Configure which materials are included in the final bundle. Enable/disable materials,
              reorder them, and see which source folders are configured.
            </p>
          </Link>

          <div className="block p-6 bg-gray-800 rounded-lg border border-gray-700 opacity-50">
            <h2 className="text-xl font-semibold mb-2">Texture Preview</h2>
            <p className="text-gray-400">
              Preview textures in 3D with tri-planar mapping. Coming soon.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
