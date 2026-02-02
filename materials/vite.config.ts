import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import fs from 'fs';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // Serve /materials from the output folder
    {
      name: 'serve-materials',
      configureServer(server) {
        server.middlewares.use('/materials', (req, res, next) => {
          const filePath = path.join(__dirname, 'output', req.url || '');
          if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            res.setHeader('Access-Control-Allow-Origin', '*');
            fs.createReadStream(filePath).pipe(res);
          } else {
            next();
          }
        });
      },
    },
    // Serve /sources for browsing source textures
    {
      name: 'serve-sources',
      configureServer(server) {
        // List sources directory
        server.middlewares.use('/api/sources', (req, res, next) => {
          if (req.url === '' || req.url === '/') {
            const sourcesDir = path.join(__dirname, 'sources');
            try {
              const folders = fs.readdirSync(sourcesDir).filter(f => 
                fs.statSync(path.join(sourcesDir, f)).isDirectory()
              );
              res.setHeader('Content-Type', 'application/json');
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.end(JSON.stringify(folders));
            } catch {
              res.statusCode = 500;
              res.end('[]');
            }
          } else {
            // List files in a specific folder
            const folder = req.url?.slice(1) || '';
            const folderPath = path.join(__dirname, 'sources', folder);
            try {
              const files = fs.readdirSync(folderPath).filter(f => 
                /\.(png|jpg|jpeg|webp)$/i.test(f)
              );
              res.setHeader('Content-Type', 'application/json');
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.end(JSON.stringify(files));
            } catch {
              res.statusCode = 404;
              res.end('[]');
            }
          }
        });
        
        // Save exported textures to sources folder
        server.middlewares.use('/api/save-texture', (req, res, next) => {
          if (req.method !== 'POST') {
            next();
            return;
          }
          
          const chunks: Buffer[] = [];
          req.on('data', (chunk: Buffer) => chunks.push(chunk));
          req.on('end', () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString());
              const { folderName, fileName, dataUrl } = body;
              
              // Validate folder name (prevent path traversal)
              if (!folderName || /[\/\\]/.test(folderName)) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: 'Invalid folder name' }));
                return;
              }
              
              // Create folder if it doesn't exist
              const folderPath = path.join(__dirname, 'sources', folderName);
              if (!fs.existsSync(folderPath)) {
                fs.mkdirSync(folderPath, { recursive: true });
              }
              
              // Extract base64 data and save
              const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, '');
              const buffer = Buffer.from(base64Data, 'base64');
              const filePath = path.join(folderPath, fileName);
              fs.writeFileSync(filePath, buffer);
              
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: true, path: filePath }));
            } catch (err) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: String(err) }));
            }
          });
        });
        
        // Serve source files
        server.middlewares.use('/sources', (req, res, next) => {
          const filePath = path.join(__dirname, 'sources', req.url || '');
          if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            res.setHeader('Access-Control-Allow-Origin', '*');
            fs.createReadStream(filePath).pipe(res);
          } else {
            next();
          }
        });

        // Get/save materials.json config
        server.middlewares.use('/api/materials-config', (req, res, next) => {
          if (req.method === 'GET') {
            const configPath = path.join(__dirname, 'config', 'materials.json');
            try {
              const data = fs.readFileSync(configPath, 'utf-8');
              res.setHeader('Content-Type', 'application/json');
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.end(data);
            } catch {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: 'Failed to read materials.json' }));
            }
          } else if (req.method === 'POST' || req.method === 'PUT') {
            const chunks: Buffer[] = [];
            req.on('data', (chunk: Buffer) => chunks.push(chunk));
            req.on('end', () => {
              try {
                const body = JSON.parse(Buffer.concat(chunks).toString());
                const configPath = path.join(__dirname, 'config', 'materials.json');
                fs.writeFileSync(configPath, JSON.stringify(body, null, 2));
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ success: true }));
              } catch (err) {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: String(err) }));
              }
            });
          } else {
            next();
          }
        });
      },
    },
  ],
  root: '.',
  publicDir: 'public',
  server: {
    port: 5174,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
