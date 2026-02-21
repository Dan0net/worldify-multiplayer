# Server-Side Light Propagation Migration Plan

## Stages

1. **Move to 48-bit voxels (RGB blocklight)**
   - Expand voxel data structure to 32 bits (31 bits used, current 16 bits + 3 x 5 rgb blocklight).
   - Add 3 × 5 bits for RGB blocklight (red, green, blue) alongside existing sunlight bits.

2. **Server propagates sunlight only**
   - Implement sunlight column propagation and BFS on server during chunk generation.
   - Store sunlight values in voxel data sent to client.

3. **Client reads server lights / removes initial sunlight propagation**
   - Update client to use sunlight values from server chunk data.
   - Remove client-side initial sunlight propagation logic.

4. **Check client renders sunlight correctly on build commits**
   - Validate sunlight rendering matches previous behavior.
   - Ensure chunk loading and meshing are correct.

5. **Add RGB blocklight propagation to server**
   - Implement RGB blocklight propagation (BFS) on server.
   - Store RGB blocklight values in voxel data sent to client.

6. **Add torches to terrain generation (lava paths)**
   - Place torch blocks in terrain generation where lava blobs are present.
   - Ensure (255, 90, 90) blocklight is emitted from torches.

7. **Read and render RGB blocklight on client; add debug mode**
   - Update client to read RGB blocklight values from voxel data.
   - Add debug mode to visualize combined RGB blocklight distribution.

8. **Check client renders sunlight and RGB blocklight correctly on build commits**
   - Validate both sunlight and RGB blocklight rendering.
   - Ensure lighting updates and chunk transitions are correct.

---

> This plan ensures a smooth migration to server-side lighting, with incremental validation at each stage.
