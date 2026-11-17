
const fs = require("fs");
const path = require("path");
const { minify: minifyJS } = require("terser");
const JavaScriptObfuscator = require("javascript-obfuscator");
const { minify: minifyHTML } = require("html-minifier-terser");
const CleanCSS = require("clean-css");

const SOURCE = path.join(__dirname, "..", "public");
const OUTPUT = path.join(__dirname, "..", "dist");

async function processDirectory(source, output) {
  fs.mkdirSync(output, { recursive: true });

  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const inputPath = path.join(source, entry.name);
    const outputPath = path.join(output, entry.name);

    if (entry.isDirectory()) {
      await processDirectory(inputPath, outputPath);
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();

    if (ext === ".js") {
      const sourceCode = fs.readFileSync(inputPath, "utf8");

      const minified = await minifyJS(sourceCode, {
        compress: true,
        mangle: true
      });

      if (!minified.code) {
        throw new Error(`JavaScript build failed: ${inputPath}`);
      }

      const protectedCode = JavaScriptObfuscator.obfuscate(
        minified.code,
        {
          compact: true,
          controlFlowFlattening: false,
          deadCodeInjection: false,
          stringArray: true,
          stringArrayThreshold: 0.5,
          renameGlobals: false,
          selfDefending: false
        }
      ).getObfuscatedCode();

      fs.writeFileSync(outputPath, protectedCode);
      console.log("Protected JS:", entry.name);
    } else if (ext === ".html") {
      const html = fs.readFileSync(inputPath, "utf8");
      const result = await minifyHTML(html, {
        collapseWhitespace: true,
        removeComments: true,
        minifyCSS: true,
        minifyJS: false
      });

      fs.writeFileSync(outputPath, result);
      console.log("Minified HTML:", entry.name);
    } else if (ext === ".css") {
      const css = fs.readFileSync(inputPath, "utf8");
      const result = new CleanCSS({}).minify(css);

      if (result.errors.length) {
        throw new Error(result.errors.join("\n"));
      }

      fs.writeFileSync(outputPath, result.styles);
      console.log("Minified CSS:", entry.name);
    } else {
      fs.copyFileSync(inputPath, outputPath);
    }
  }
}

async function main() {
  if (!fs.existsSync(SOURCE)) {
    throw new Error("public folder not found.");
  }

  fs.rmSync(OUTPUT, { recursive: true, force: true });
  await processDirectory(SOURCE, OUTPUT);

  console.log("\nProtected production build created in dist/");
}

main().catch(error => {
  console.error("Build failed:", error.message);
  process.exitCode = 1;
});
