/**
 * @fileoverview Portable MCPB artifact invariants.
 * @module scripts/portable-bundle
 */

/** Native inference packages must be absent from the cleaned artifact. */
export function includePortableDependency(source: string): boolean {
  const segments = source.split(/[\\/]/);
  return !segments.some(
    (segment) =>
      ['sharp', '@img', 'onnxruntime-node', '.bin'].includes(segment) ||
      segment.startsWith('node-bindings-') ||
      /\.(node|dylib|dll|so)(\.\d+)*$/.test(segment),
  );
}

/** Rewrite only the staged import; fail if an upstream build changes the known seam. */
export function routePortableEmbeddings(source: string): string {
  const native = "from '@huggingface/transformers'";
  if (source.split(native).length !== 2) {
    throw new Error('Expected exactly one Transformers import in the built embeddings runtime.');
  }
  return source.replace(native, "from '../../portable/transformers.mjs'");
}
