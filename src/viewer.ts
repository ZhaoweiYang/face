// Three.js scene that renders the textured face mesh.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { FaceModel, type ExpressionParams } from "./faceModel";

export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private group = new THREE.Group();
  private faceMesh: THREE.Mesh | null = null;
  private mouthMesh: THREE.Mesh | null = null;
  private positions: THREE.BufferAttribute | null = null;
  private model: FaceModel | null = null;
  private texture: THREE.Texture | null = null;
  private faceMaterial: THREE.MeshBasicMaterial;
  private mouthMaterial: THREE.MeshBasicMaterial;
  private clock = new THREE.Clock();
  autoSway = true;
  private idleSince = 0;

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(28, 1, 0.01, 100);
    this.camera.position.set(0, 0, 2.6);
    this.scene.add(this.group);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enablePan = false;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 1.2;
    this.controls.maxDistance = 5;
    this.controls.minPolarAngle = Math.PI / 2 - 0.55;
    this.controls.maxPolarAngle = Math.PI / 2 + 0.55;
    this.controls.minAzimuthAngle = -0.8;
    this.controls.maxAzimuthAngle = 0.8;
    this.controls.addEventListener("start", () => {
      this.idleSince = this.clock.elapsedTime;
    });

    this.faceMaterial = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    this.mouthMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color("#1a0608"),
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 2,
      polygonOffsetUnits: 2,
    });

    this.resize();
    window.addEventListener("resize", () => this.resize());
    this.renderer.setAnimationLoop(() => this.frame());
  }

  resize(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.fitCamera();
  }

  private fitCamera(): void {
    // Fit a unit-height (aspect-width) plane into the view.
    const aspect = this.model?.aspect ?? 1;
    const vFov = THREE.MathUtils.degToRad(this.camera.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const dV = 0.5 / Math.tan(vFov / 2);
    const dH = aspect / 2 / Math.tan(hFov / 2);
    const d = Math.max(dV, dH) * 1.12;
    const dir = this.camera.position.clone().normalize();
    this.camera.position.copy(dir.multiplyScalar(d));
    this.controls.minDistance = d * 0.5;
    this.controls.maxDistance = d * 2.2;
    this.controls.update();
  }

  get hasModel(): boolean {
    return this.model !== null;
  }

  /** Replaces the current face with a new model + texture. */
  setModel(model: FaceModel, image: HTMLImageElement | HTMLCanvasElement, params: ExpressionParams): void {
    this.clear();
    this.model = model;

    const tex = new THREE.Texture(image);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    tex.needsUpdate = true;
    this.texture = tex;
    this.faceMaterial.map = tex;
    this.faceMaterial.needsUpdate = true;

    const positions = new THREE.BufferAttribute(new Float32Array(model.vertexCount * 3), 3);
    positions.setUsage(THREE.DynamicDrawUsage);
    this.positions = positions;
    const uv = new THREE.BufferAttribute(model.uv, 2);

    const faceGeo = new THREE.BufferGeometry();
    faceGeo.setAttribute("position", positions);
    faceGeo.setAttribute("uv", uv);
    faceGeo.setIndex(model.faceIndex);

    const mouthGeo = new THREE.BufferGeometry();
    mouthGeo.setAttribute("position", positions);
    mouthGeo.setIndex(model.mouthIndex);

    this.faceMesh = new THREE.Mesh(faceGeo, this.faceMaterial);
    this.mouthMesh = new THREE.Mesh(mouthGeo, this.mouthMaterial);
    this.mouthMesh.renderOrder = -1;
    this.group.add(this.mouthMesh, this.faceMesh);

    this.update(params);
    this.controls.reset();
    this.camera.position.set(0, 0, 2.6);
    this.fitCamera();
    this.idleSince = this.clock.elapsedTime;
  }

  /** Recomputes vertex positions for the given expression parameters. */
  update(params: ExpressionParams): void {
    if (!this.model || !this.positions) return;
    this.model.computePositions(params, this.positions.array as Float32Array);
    this.positions.needsUpdate = true;
    this.faceMesh?.geometry.computeBoundingSphere();
  }

  setWireframe(on: boolean): void {
    this.faceMaterial.wireframe = on;
    this.mouthMaterial.wireframe = on;
  }

  clear(): void {
    if (this.faceMesh) {
      this.group.remove(this.faceMesh);
      this.faceMesh.geometry.dispose();
      this.faceMesh = null;
    }
    if (this.mouthMesh) {
      this.group.remove(this.mouthMesh);
      this.mouthMesh.geometry.dispose();
      this.mouthMesh = null;
    }
    this.texture?.dispose();
    this.texture = null;
    this.model = null;
    this.positions = null;
  }

  /** Renders the current frame to a PNG data URL. */
  snapshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL("image/png");
  }

  private frame(): void {
    const t = this.clock.getElapsedTime();
    // Gentle idle sway so the relief is visible without dragging.
    let target = 0;
    if (this.autoSway && this.model && t - this.idleSince > 1.5) {
      target = Math.sin((t - this.idleSince - 1.5) * 0.9) * 0.16;
    }
    this.group.rotation.y += (target - this.group.rotation.y) * 0.05;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
