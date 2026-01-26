/**
 * Quantization utilities for compact network encoding
 */
/**
 * Quantize angle (radians) to int16 for network transmission
 * Range: -PI to PI -> -32768 to 32767
 */
export declare function quantizeAngle(radians: number): number;
/**
 * Dequantize int16 back to radians
 */
export declare function dequantizeAngle(quantized: number): number;
/**
 * Quantize position to int16 with fixed precision
 * @param value Position in meters
 * @param precision Centimeters per unit (default 1cm)
 */
export declare function quantizePosition(value: number, precision?: number): number;
/**
 * Dequantize position back to meters
 */
export declare function dequantizePosition(quantized: number, precision?: number): number;
//# sourceMappingURL=quantize.d.ts.map