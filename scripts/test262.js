const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jsYaml = require('js-yaml');
const child_process = require('child_process');

function findFiles() {
  function visit(dir) {
    for (const entry of fs.readdirSync(dir)) {
      const fullEntry = path.join(dir, entry);
      const stats = fs.statSync(fullEntry);
      if (stats.isDirectory()) {
        visit(fullEntry);
      } else if (stats.isFile() && entry.endsWith('.js') && !entry.endsWith('_FIXTURE.js')) {
        files.push(fullEntry);
      }
    }
  }

  const files = [];
  visit(path.join(__dirname, '..', 'demo', 'test262', 'test'));
  return files;
}

async function main() {
  const esbuild = path.join(__dirname, '..', 'esbuild');
  const files = findFiles();
  let runCount = 0;
  let shouldHavePassed = 0;
  let shouldHaveFailed = 0;
  let reparseCount = 0;
  let reprintCount = 0;
  let minifyCount = 0;

  function esbuildFile(file, outfile, {minify}) {
    const child = child_process.spawn(esbuild, [
      file,
      `--outfile=${outfile}`,
    ].concat(
      minify ? ['--minify'] : []
    ), {
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    let done = false;
    const promise = new Promise(resolve => {
      const chunks = [];
      child.stderr.on('data', chunk => chunks.push(chunk));
      child.on('close', status => {
        done = true;
        resolve({
          status,
          stderr: Buffer.concat(chunks).toString(),
        });
      })
    });
    const timeout = new Promise((_, reject) => {
      setTimeout(() => {
        if (!done) {
          console.log(`${file}: TIMED OUT!`);
          child.kill();
          reject();
        }
      }, 1000);
    });
    return Promise.race([promise, timeout]);
  }

  async function processFile(file) {
    const content = fs.readFileSync(file, 'utf8');
    const start = content.indexOf('/*---');
    const end = content.indexOf('---*/');
    if (start < 0 || end < 0) {
      console.warn(`Missing YAML metadata: ${file}`);
      return;
    }
    const yaml = jsYaml.safeLoad(content.slice(start + 5, end));
    const shouldParse = !yaml.negative || yaml.negative.phase === 'runtime';

    if (yaml.features) {
      if (yaml.features.includes('class-fields-private')) return
      if (yaml.features.includes('class-methods-private')) return
      if (yaml.features.includes('class-static-fields-private')) return
      if (yaml.features.includes('class-static-methods-private')) return
      if (yaml.features.includes('hashbang')) return
      if (yaml.features.includes('regexp-match-indices')) return
      if (yaml.features.includes('regexp-named-groups')) return
      if (yaml.features.includes('regexp-unicode-property-escapes')) return
      if (yaml.features.includes('top-level-await')) return
    }

    const hash = crypto.createHash('md5').update(file).digest('hex');
    const output1 = path.join(process.env.HOME, '.Trash', hash + '-1.js');
    const output2 = path.join(process.env.HOME, '.Trash', hash + '-2.js');
    const result = await esbuildFile(file, output1, {minify: false});
    const parsed = result.status === 0;

    if (parsed !== shouldParse) {
      if (!parsed) shouldHavePassed++;
      else shouldHaveFailed++;
      if (!result.stderr.includes(path.basename(file))) {
        console.log(`${file}: error: ${(yaml.description || '').trim()}`);
      } else {
        process.stdout.write(result.stderr);
      }
    } else if (parsed) {
      const result2 = await esbuildFile(output1, output2, {minify: false});
      if (result2.status !== 0) {
        console.log(`!!! REPARSE ERROR: ${file} !!!`);
        process.stdout.write(result2.stderr);
        reparseCount++;
      } else if (fs.readFileSync(output1, 'utf8') !== fs.readFileSync(output2, 'utf8')) {
        console.log(`!!! REPRINT ERROR: ${file} !!!`);
        reprintCount++;
      } else {
        const result3 = await esbuildFile(file, output1, {minify: true});
        if (result3.status !== 0) {
          throw new Error('This should have succeeded');
        }
        const result4 = await esbuildFile(output1, output2, {minify: true});
        if (result4.status !== 0) {
          console.log(`!!! MINIFY ERROR: ${file} !!!`);
          process.stdout.write(result4.stderr);
          minifyCount++;
        }
      }
    }
    runCount++;
  }

  // Process tests in parallel for speed
  await new Promise((resolve, reject) => {
    let inFlight = 0;
    let i = 0;

    function next() {
      if (i === files.length && inFlight === 0) {
        return resolve();
      }

      while (i < files.length && inFlight < 5) {
        inFlight++;
        processFile(files[i++]).then(() => {
          inFlight--;
          next();
        }, reject);
      }
    }

    next();
  });

  console.log(`tests ran: ${runCount}`);
  console.log(`  tests incorrectly failed: ${shouldHavePassed}`);
  console.log(`  tests incorrectly passed: ${shouldHaveFailed}`);
  console.log(`tests skipped: ${files.length - runCount}`);
  console.log(`reparse failures: ${reparseCount}`);
  console.log(`reprint failures: ${reprintCount}`);
  console.log(`minify failures: ${minifyCount}`);
}

main().catch(e => setTimeout(() => {
  throw e
}));
