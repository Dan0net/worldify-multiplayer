/**
 * Quantization utilities for compact network encoding
 */
/**
 * Quantize angle (radians) to int16 for network transmission
 * Range: -PI to PI -> -32768 to 32767
 */
export function quantizeAngle(radians) {
    return Math.round((radians / Math.PI) * 32767);
}
/**
 * Dequantize int16 back to radians
 */
export function dequantizeAngle(quantized) {
    return (quantized / 32767) * Math.PI;
}
/**
 * Quantize position to int16 with fixed precision
 * @param value Position in meters
 * @param precision Centimeters per unit (default 1cm)
 */
export function quantizePosition(value, precision = 100) {
    return Math.round(value * precision);
}
/**
 * Dequantize position back to meters
 */
export function dequantizePosition(quantized, precision = 100) {
    return quantized / precision;
}
//# sourceMappingURL=quantize.js.map