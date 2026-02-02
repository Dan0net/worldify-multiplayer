import { Routes, Route, Link } from 'react-router-dom';
import { MaterialViewer } from './pages/MaterialViewer';
import { Home } from './pages/Home';
import { PalletEditor } from './pages/PalletEditor';
import { LeafTextureEditor } from './leaf-editor/LeafTextureEditor';

function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/materials" element={<MaterialViewer />} />
      <Route path="/pallet" element={<PalletEditor />} />
      <Route path="/leaf-editor" element={<LeafTextureEditor />} />
    </Routes>
  );
}

export default App;
