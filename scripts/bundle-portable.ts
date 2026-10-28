/**
 * @fileoverview Stage a portable MCPB without changing the native npm build.
 * @module scripts/bundle-portable
 */
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { includePortableDependency, routePortableEmbeddings } from './portable-bundle.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function main(): Promise<void> {
  const transformersRoot = dirname(
    dirname(fileURLToPath(import.meta.resolve('@huggingface/transformers'))),
  );
  const transformers = JSON.parse(await readFile(join(transformersRoot, 'package.json'), 'utf8'));
  if (transformers.version !== '4.3.1') {
    throw new Error(
      'Portable ONNX injection requires Transformers 4.3.1; verify the adapter before upgrading.',
    );
  }
  const stage = await mkdtemp(join(tmpdir(), 'cyanheads-mcpb-'));
  try {
    for (const name of [
      'dist',
      'node_modules',
      'package.json',
      'manifest.json',
      'skills',
      '.mcpbignore',
      'README.md',
      'LICENSE',
    ]) {
      await cp(join(root, name), join(stage, name), {
        recursive: true,
        dereference: true,
        filter: (source) => !source.split(/[\\/]/).includes('.bin') && !source.endsWith('.mcpb'),
      });
    }
    await mkdir(join(stage, 'dist', 'portable'), { recursive: true });
    const portable = await realpath(join(stage, 'dist', 'portable'));
    await cp(join(root, 'scripts', 'portable-transformers.mjs'), join(portable, 'adapter.mjs'));
    await cp(
      join(transformersRoot, 'dist', 'transformers.web.js'),
      join(portable, 'transformers.web.js'),
    );
    await cp(join(transformersRoot, 'LICENSE'), join(portable, 'transformers.LICENSE'));
    await cp(
      join(root, 'scripts', 'portable-licenses', 'onnxruntime.LICENSE'),
      join(portable, 'onnxruntime.LICENSE'),
    );
    const ortRoot = dirname(fileURLToPath(import.meta.resolve('onnxruntime-web')));
    for (const name of [
      'ort.node.min.mjs',
      'ort-wasm-simd-threaded.mjs',
      'ort-wasm-simd-threaded.wasm',
    ]) {
      await cp(join(ortRoot, name), join(portable, name));
    }
    const generated = await Bun.build({
      entrypoints: [join(portable, 'adapter.mjs')],
      target: 'node',
      format: 'esm',
      packages: 'bundle',
      plugins: [
        {
          name: 'portable-onnx-runtime',
          setup(build) {
            build.onResolve({ filter: /^onnxruntime-web\/webgpu$/ }, () => ({
              path: join(portable, 'ort.node.min.mjs'),
            }));
          },
        },
      ],
    });
    if (!generated.success)
      throw new AggregateError(generated.logs, 'Portable adapter generation failed.');
    const [output] = generated.outputs;
    if (!output || generated.outputs.length !== 1)
      throw new Error('Expected one portable adapter module.');
    await writeFile(join(portable, 'transformers.mjs'), await output.text());
    for (const name of ['adapter.mjs', 'transformers.web.js', 'ort.node.min.mjs']) {
      await rm(join(portable, name));
    }
    const stagedPackage = JSON.parse(await readFile(join(stage, 'package.json'), 'utf8'));
    delete stagedPackage.dependencies['@huggingface/transformers'];
    await writeFile(join(stage, 'package.json'), `${JSON.stringify(stagedPackage, null, 2)}\n`);
    const runtime = join(stage, 'dist', 'services', 'catalog', 'embeddings-runtime.js');
    await writeFile(runtime, routePortableEmbeddings(await readFile(runtime, 'utf8')));
    const bundle = join(root, 'dist', 'cyanheads-mcp-server.mcpb');
    execFileSync('npx', ['-y', '@anthropic-ai/mcpb', 'pack', stage, bundle], { stdio: 'inherit' });
    execFileSync('bun', ['run', join(root, 'scripts', 'clean-mcpb.ts'), bundle], {
      stdio: 'inherit',
    });
    const entries = execFileSync('unzip', ['-Z1', bundle], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }).split('\n');
    const natives = entries.filter((entry) => !includePortableDependency(entry));
    if (natives.length)
      throw new Error(
        `Cleaned portable bundle contains native dependencies: ${natives.join(', ')}`,
      );
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
