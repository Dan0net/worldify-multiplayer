import { describe, it, expect } from 'vitest';
import { sdfSphere, sdfBox, sdfCylinder, sdfPrism } from './shapes.js';
import * as THREE from 'three';

describe('SDF shapes', () => {
  describe('sdfSphere', () => {
    it('returns negative inside sphere', () => {
      const center = new THREE.Vector3(0, 0, 0);
      expect(sdfSphere(center, 5)).toBeLessThan(0);
    });

    it('returns zero on surface', () => {
      const surface = new THREE.Vector3(5, 0, 0);
      expect(sdfSphere(surface, 5)).toBeCloseTo(0, 5);
    });

    it('returns positive outside sphere', () => {
      const outside = new THREE.Vector3(10, 0, 0);
      expect(sdfSphere(outside, 5)).toBeGreaterThan(0);
    });
  });

  describe('sdfBox', () => {
    it('returns negative inside box', () => {
      const inside = new THREE.Vector3(0.5, 0.5, 0.5);
      const size = new THREE.Vector3(2, 2, 2);
      expect(sdfBox(inside, size)).toBeLessThan(0);
    });

    it('returns positive outside box', () => {
      const outside = new THREE.Vector3(5, 0, 0);
      const size = new THREE.Vector3(2, 2, 2);
      expect(sdfBox(outside, size)).toBeGreaterThan(0);
    });
  });

  describe('sdfCylinder', () => {
    it('returns negative inside cylinder', () => {
      const inside = new THREE.Vector3(0, 0, 0);
      expect(sdfCylinder(inside, 2, 3)).toBeLessThan(0);
    });

    it('returns positive outside cylinder radius', () => {
      const outside = new THREE.Vector3(5, 0, 0);
      expect(sdfCylinder(outside, 2, 3)).toBeGreaterThan(0);
    });

    it('returns positive above cylinder height', () => {
      const above = new THREE.Vector3(0, 10, 0);
      expect(sdfCylinder(above, 2, 3)).toBeGreaterThan(0);
    });
  });

  describe('sdfPrism', () => {
    it('returns negative inside prism', () => {
      // Prism has right angle at origin, so center is offset
      // Point inside the triangle needs to be in the interior
      const inside = new THREE.Vector3(-0.5, -0.5, 0);
      expect(sdfPrism(inside, 2, 2, 2)).toBeLessThan(0);
    });

    it('returns positive outside prism', () => {
      const outside = new THREE.Vector3(10, 10, 10);
      expect(sdfPrism(outside, 2, 2, 2)).toBeGreaterThan(0);
    });
  });

  describe('SDF consistency', () => {
    it('distance increases as point moves away from shape', () => {
      const d1 = sdfSphere(new THREE.Vector3(6, 0, 0), 5);
      const d2 = sdfSphere(new THREE.Vector3(8, 0, 0), 5);
      const d3 = sdfSphere(new THREE.Vector3(10, 0, 0), 5);

      expect(d2).toBeGreaterThan(d1);
      expect(d3).toBeGreaterThan(d2);
    });
  });
});
