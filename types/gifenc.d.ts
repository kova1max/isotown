// gifenc ships no types; this covers the part isotown uses. It is CommonJS,
// so it is imported as a default export.
declare module "gifenc" {
  type Palette = number[][];
  interface GIFEncoderInstance {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      opts?: { palette?: Palette; delay?: number; repeat?: number; transparent?: boolean; dispose?: number },
    ): void;
    finish(): void;
    bytes(): Uint8Array;
  }
  const gifenc: {
    GIFEncoder(opts?: { auto?: boolean }): GIFEncoderInstance;
    quantize(
      rgba: Uint8Array | Uint8ClampedArray,
      maxColors: number,
      opts?: { format?: "rgb565" | "rgb444" | "rgba4444"; oneBitAlpha?: boolean | number; clearAlpha?: boolean },
    ): Palette;
    applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: Palette, format?: "rgb565" | "rgb444" | "rgba4444"): Uint8Array;
  };
  export default gifenc;
}
