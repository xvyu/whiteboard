// Post-build script:
// 1. Strip type="module" / crossorigin from dist HTML
// 2. Inline JS into HTML (avoid ES module export issues)
// 3. Inline CSS into HTML (avoid extra network requests)
// 4. Move inlined script to end of <body> so DOM is ready when it runs
// 5. Strip modulepreload links
const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, '..', 'dist');

// Find HTML files
const htmlFiles = fs.readdirSync(distDir).filter(f => f.endsWith('.html'));

for (const file of htmlFiles) {
  const filePath = path.join(distDir, file);
  let content = fs.readFileSync(filePath, 'utf-8');

  // Collect all inline scripts to append at end of body
  const scriptsToAppend = [];

  // Find all <script ... src="/assets/..."> tags (not modulepreload)
  const scriptSrcRegex = /<script[^>]*src=["'](\/assets\/[^"']+)["'][^>]*><\/script>/g;
  let match;

  while ((match = scriptSrcRegex.exec(content)) !== null) {
    const [fullMatch, srcPath] = match;
    // Read the JS file
    const jsFilePath = path.join(distDir, srcPath.replace(/^\//, ''));
    if (fs.existsSync(jsFilePath)) {
      let jsContent = fs.readFileSync(jsFilePath, 'utf-8');
      // Remove any `export {}` or `export { ... }` statements (ES module artifacts)
      jsContent = jsContent.replace(/^export\s*\{[^}]*\}\s*;?\s*$/gm, '');
      jsContent = jsContent.replace(/^export\s+default\s+[^;]+;?\s*$/gm, '');
      // Remove source map comments to avoid 404 console warnings
      jsContent = jsContent.replace(/\/\/# sourceMappingURL=.*$/gm, '');
      scriptsToAppend.push({ fullMatch, jsContent });
    }
  }

  // Remove original script tags from head
  for (const { fullMatch } of scriptsToAppend) {
    content = content.replace(fullMatch, '');
  }

  // Remove modulepreload links
  content = content.replace(/<link[^>]*rel=["']modulepreload["'][^>]*>\s*/g, '');

  // Remove type="module" and crossorigin from any remaining script tags
  content = content.replace(/\s+type=["']module["']/g, '');
  content = content.replace(/\s+crossorigin(=["'][^"']*["'])?/g, '');

  // Remove modulepreload polyfill inline script (the IIFE that was in <head>)
  content = content.replace(/<script>\s*\(function\(\)\s*\{[\s\S]*?\}\)\(\);\s*<\/script>/g, '');

  // Inline CSS
  const cssLinkRegex = /<link[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>\s*/g;
  let cssMatch;
  const cssToInline = [];

  while ((cssMatch = cssLinkRegex.exec(content)) !== null) {
    const [fullMatch, cssPath] = cssMatch;
    const cssFilePath = path.join(distDir, cssPath.replace(/^\//, ''));
    if (fs.existsSync(cssFilePath)) {
      const cssContent = fs.readFileSync(cssFilePath, 'utf-8');
      cssToInline.push({ fullMatch, cssContent });
    }
  }

  // Replace CSS links with inline style tags
  for (const { fullMatch, cssContent } of cssToInline) {
    content = content.replace(fullMatch, `<style>${cssContent}</style>\n`);
  }

  // Append inlined scripts at the end of <body>
  for (const { jsContent } of scriptsToAppend) {
    const inlineTag = `<script>${jsContent}</script>`;
    content = content.replace(/<\/body>/, `${inlineTag}\n</body>`);
  }

  fs.writeFileSync(filePath, content, 'utf-8');
  console.log('Fixed + inlined JS/CSS:', file);
}

// Also strip CSS link crossorigin attributes
const allHtmlFiles = fs.readdirSync(distDir).filter(f => f.endsWith('.html'));
for (const file of allHtmlFiles) {
  const filePath = path.join(distDir, file);
  let content = fs.readFileSync(filePath, 'utf-8');
  content = content.replace(/\s+crossorigin(=["'][^"']*["'])?/g, '');
  fs.writeFileSync(filePath, content, 'utf-8');
}

console.log('Post-build fix complete.');
