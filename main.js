import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GUI } from 'three/examples/jsm/libs/lil-gui.module.min.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// ── Scene ───────────────────────────────────────────────────────────
const canvas = document.querySelector('#app-canvas');
const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(30, window.innerWidth / window.innerHeight, 0.1, 500);
const dpr = Math.min(window.devicePixelRatio, 2);
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(dpr);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;

// ── Params ──────────────────────────────────────────────────────────
const params = {
    // Camera
    camX: -0.7, camY: 1, camZ: 2.6, camFOV: 24, lookAtY: 0.3,
    // Model
    modelRotY: 208, modelScale: 1, modelColorTint: '#ffffff', modelTintStrength: 1,
    // Key Light
    keyIntensity: 1.4, keyX: 7.5, keyY: 10, keyZ: 3.5, keyColor: '#ffffff',
    shadowRadius: 1.5, shadowMapSize: 4096,
    // Fill Light
    fillIntensity: 0, fillX: -15.5, fillY: 11, fillZ: -22.5, fillColor: '#ffffff',
    // Rim Light
    rimIntensity: 1.8, rimX: 30.5, rimY: -6, rimZ: -16.5, rimColor: '#fff76b',
    // Ambient
    ambientIntensity: 0.35, ambientColor: '#ffffff',
    // Hemisphere
    hemiIntensity: 0.25, hemiSkyColor: '#d6d6d6', hemiGroundColor: '#ffffff',
    // Background & Floor
    bgColor: '#ffffff', floorColor: '#ffffff',
    // Tone Mapping
    toneMapping: 'Cineon', exposure: 2.7,
    // Parallax
    parallaxStrength: 0.3, parallaxEnabled: true,
    // Hover X-Ray reveal
    hoverEnabled: true,
    hoverRadiusChurch: 0.25,
    hoverRadiusFloor: 1.5,
    xrayColor: '#ffffff',
    xrayOpacity: 0.1,
    edgeColor: '#ffffff',
    edgeOpacity: 1.0,
    edgeThresholdAngle: 25,
    floorGridColor: '#cccccc',
    floorGridOpacity: 0.5,
    // Actions
    exportSettings: () => {
        const json = JSON.stringify(params, null, 2);
        navigator.clipboard.writeText(json).then(() => alert('Settings JSON copied!'));
    },
};

// ── Tone mapping ─────────────────────────────────────────────────────
const toneMappingOptions = {
    'None': THREE.NoToneMapping, 'Linear': THREE.LinearToneMapping,
    'Reinhard': THREE.ReinhardToneMapping, 'Cineon': THREE.CineonToneMapping,
    'ACES Filmic': THREE.ACESFilmicToneMapping, 'AgX': THREE.AgXToneMapping,
    'Neutral': THREE.NeutralToneMapping,
};
function applyToneMapping() {
    renderer.toneMapping = toneMappingOptions[params.toneMapping];
    renderer.toneMappingExposure = params.exposure;
    scene.traverse((c) => { if (c.isMesh && c.material) c.material.needsUpdate = true; });
}
applyToneMapping();

// ── Background ───────────────────────────────────────────────────────
document.body.style.backgroundColor = params.bgColor;

// ── Lighting ─────────────────────────────────────────────────────────
const ambientLight = new THREE.AmbientLight(params.ambientColor, params.ambientIntensity);
scene.add(ambientLight);
const hemiLight = new THREE.HemisphereLight(params.hemiSkyColor, params.hemiGroundColor, params.hemiIntensity);
scene.add(hemiLight);

const keyLight = new THREE.DirectionalLight(params.keyColor, params.keyIntensity);
keyLight.position.set(params.keyX, params.keyY, params.keyZ);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(params.shadowMapSize, params.shadowMapSize);
keyLight.shadow.camera.near = 0.5;
keyLight.shadow.camera.far = 150;
const sd = 35;
keyLight.shadow.camera.left = -sd; keyLight.shadow.camera.right = sd;
keyLight.shadow.camera.top = sd; keyLight.shadow.camera.bottom = -sd;
keyLight.shadow.bias = -0.0002;
keyLight.shadow.normalBias = 0.02;
keyLight.shadow.radius = params.shadowRadius;
scene.add(keyLight); scene.add(keyLight.target);

const fillLight = new THREE.DirectionalLight(params.fillColor, params.fillIntensity);
fillLight.position.set(params.fillX, params.fillY, params.fillZ);
scene.add(fillLight);
const rimLight = new THREE.DirectionalLight(params.rimColor, params.rimIntensity);
rimLight.position.set(params.rimX, params.rimY, params.rimZ);
scene.add(rimLight);

// ── Floor ────────────────────────────────────────────────────────────
const floorGeo = new THREE.PlaneGeometry(500, 500);
// Usando ShadowMaterial para que o chão seja transparente, mostrando o fundo/texto, mas ainda recebendo sombras!
const floorMat = new THREE.ShadowMaterial({ opacity: 0.3 });
const floor = new THREE.Mesh(floorGeo, floorMat);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

// ── Shared hover uniforms ────────────────────────────────────────────
const hoverUniforms = {
    uTime:        { value: 0.0 },
    uMouse:       { value: new THREE.Vector2(-1000, -1000) },
    uResolution:  { value: new THREE.Vector2(window.innerWidth * dpr, window.innerHeight * dpr) },
    
    uHitPoint:    { value: new THREE.Vector3(0, -999, 0) },
    uActive:      { value: 0.0 },
    
    uRadiusChurch: { value: params.hoverRadiusChurch },
    uRadiusFloor:  { value: params.hoverRadiusFloor },
    
    uXrayColor:   { value: new THREE.Color(params.xrayColor) },
    uXrayOpacity: { value: params.xrayOpacity },
};

// ── Shader injection for X-Ray base ──────────────────────────────────
function injectXRayShader(material) {
    material.transparent = false;

    const origOnBeforeCompile = material.onBeforeCompile;
    material.onBeforeCompile = (shader) => {
        if (origOnBeforeCompile) origOnBeforeCompile(shader);
        shader.uniforms.uTime = hoverUniforms.uTime;
        shader.uniforms.uMouse = hoverUniforms.uMouse;
        shader.uniforms.uResolution = hoverUniforms.uResolution;
        shader.uniforms.uHitPoint = hoverUniforms.uHitPoint;
        shader.uniforms.uRadius = hoverUniforms.uRadiusChurch;
        shader.uniforms.uActive = hoverUniforms.uActive;
        shader.uniforms.uXrayColor = hoverUniforms.uXrayColor;
        shader.uniforms.uXrayOpacity = hoverUniforms.uXrayOpacity;

        shader.vertexShader = shader.vertexShader.replace(
            '#include <common>',
            `#include <common>\nvarying vec3 vHoverWorldPos;`
        );
        shader.vertexShader = shader.vertexShader.replace(
            '#include <fog_vertex>',
            `#include <fog_vertex>\nvHoverWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;`
        );
        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <common>',
            `#include <common>\nuniform float uTime;\nuniform vec2 uMouse;\nuniform vec2 uResolution;\nuniform vec3 uHitPoint;\nuniform float uRadius;\nuniform float uActive;\nuniform vec3 uXrayColor;\nuniform float uXrayOpacity;\nvarying vec3 vHoverWorldPos;`
        );
        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <dithering_fragment>',
            `#include <dithering_fragment>
            vec2 fragCoord = gl_FragCoord.xy / uResolution.y;
            vec2 mouseCoord = uMouse / uResolution.y;
            vec2 dir = fragCoord - mouseCoord;
            float angle = atan(dir.y, dir.x);
            float wobble = sin(angle * 4.0 + uTime * 2.5) * 0.03 
                         + cos(angle * 7.0 - uTime * 3.5) * 0.015;
            
            float hDist = distance(vHoverWorldPos, uHitPoint);
            float hMask = step(hDist, uRadius + wobble);
            
            float targetAlpha = mix(1.0, uXrayOpacity, hMask * uActive);
            vec2 p = floor(mod(gl_FragCoord.xy, 2.0));
            float ditherThreshold = (p.x + p.y * 2.0) * 0.25;
            if (targetAlpha <= ditherThreshold) discard;
            
            gl_FragColor.rgb = mix(gl_FragColor.rgb, uXrayColor, hMask * uActive);
            `
        );
    };
    material.customProgramCacheKey = () => 'hover-xray-' + material.uuid;
}

// ── Reveal shader — used for church edges ───────────────
function makeRevealMaterialChurch(color, opacity) {
    return new THREE.ShaderMaterial({
        uniforms: {
            uTime:       hoverUniforms.uTime,
            uMouse:      hoverUniforms.uMouse,
            uResolution: hoverUniforms.uResolution,
            uHitPoint:   hoverUniforms.uHitPoint,
            uRadius:     hoverUniforms.uRadiusChurch,
            uActive:     hoverUniforms.uActive,
            uColor:      { value: new THREE.Color(color) },
            uOpacity:    { value: opacity },
        },
        vertexShader: /* glsl */ `
            varying vec3 vWorldPos;
            void main() {
                vec4 wp = modelMatrix * vec4(position, 1.0);
                vWorldPos = wp.xyz;
                gl_Position = projectionMatrix * viewMatrix * wp;
            }
        `,
        fragmentShader: /* glsl */ `
            uniform float uTime;
            uniform vec2  uMouse;
            uniform vec2  uResolution;
            uniform vec3  uHitPoint;
            uniform float uRadius;
            uniform float uActive;
            uniform vec3  uColor;
            uniform float uOpacity;
            varying vec3  vWorldPos;
            void main() {
                vec2 fragCoord = gl_FragCoord.xy / uResolution.y;
                vec2 mouseCoord = uMouse / uResolution.y;
                vec2 dir = fragCoord - mouseCoord;
                float angle = atan(dir.y, dir.x);
                float wobble = sin(angle * 4.0 + uTime * 2.5) * 0.03 
                             + cos(angle * 7.0 - uTime * 3.5) * 0.015;
                             
                float hDist = distance(vWorldPos, uHitPoint);
                float reveal = step(hDist, uRadius + wobble) * uActive;
                if (reveal < 0.02) discard;
                gl_FragColor = vec4(uColor, reveal * uOpacity);
            }
        `,
        transparent: true, depthTest: true, depthWrite: false, side: THREE.DoubleSide,
    });
}

// ── Reveal shader — used for floor grid ───────────────
function makeRevealMaterialFloor(color, opacity) {
    return new THREE.ShaderMaterial({
        uniforms: {
            uHitPoint: hoverUniforms.uHitPoint,
            uRadius:   hoverUniforms.uRadiusFloor,
            uActive:   hoverUniforms.uActive,
            uColor:    { value: new THREE.Color(color) },
            uOpacity:  { value: opacity },
        },
        vertexShader: /* glsl */ `
            varying vec3 vWorldPos;
            void main() {
                vec4 wp = modelMatrix * vec4(position, 1.0);
                vWorldPos = wp.xyz;
                gl_Position = projectionMatrix * viewMatrix * wp;
            }
        `,
        fragmentShader: /* glsl */ `
            uniform vec3  uHitPoint;
            uniform float uRadius;
            uniform float uActive;
            uniform vec3  uColor;
            uniform float uOpacity;
            varying vec3  vWorldPos;
            void main() {
                float dist   = distance(vWorldPos, uHitPoint);
                float reveal = (1.0 - smoothstep(0.0, uRadius, dist)) * uActive;
                if (reveal < 0.02) discard;
                gl_FragColor = vec4(uColor, reveal * uOpacity);
            }
        `,
        transparent: true, depthTest: true, depthWrite: false, side: THREE.DoubleSide,
    });
}

const edgeRevealMat = makeRevealMaterialChurch(params.edgeColor, params.edgeOpacity);
const floorGridMat  = makeRevealMaterialFloor(params.floorGridColor, params.floorGridOpacity);

// ── Floor grid wireframe ─────────────────────────────────────────────
const floorWireGeo = new THREE.PlaneGeometry(6, 6, 60, 60);
const floorWireframe = new THREE.WireframeGeometry(floorWireGeo);
const floorWireLines = new THREE.LineSegments(floorWireframe, floorGridMat);
floorWireLines.rotation.x = -Math.PI / 2;
floorWireLines.position.y = 0.001;
scene.add(floorWireLines);

// ── Mouse tracking & Raycaster ───────────────────────────────────────
const raycaster = new THREE.Raycaster();
const mouseNDC = new THREE.Vector2(-10, -10);
const pixelMouse = new THREE.Vector2(-1000, -1000);
const smoothMouse = new THREE.Vector2(-1000, -1000);
let targetActive = 0;
let firstMove = true;
let modelMeshes = [];
let frameCount = 0;

window.addEventListener('mousemove', (e) => {
    mouseNDC.x =  (e.clientX / window.innerWidth)  * 2 - 1;
    mouseNDC.y = -(e.clientY / window.innerHeight) * 2 + 1;
    pixelMouse.x = e.clientX * dpr;
    pixelMouse.y = (window.innerHeight - e.clientY) * dpr;
    
    if (firstMove) {
        smoothMouse.copy(pixelMouse);
        firstMove = false;
    }
    
    targetActive = 1;
});
window.addEventListener('mouseleave', () => {
    targetActive = 0;
    firstMove = true;
});

// ── Mouse parallax ───────────────────────────────────────────────────
const mouse = { x: 0, y: 0 };
const targetMouse = { x: 0, y: 0 };
window.addEventListener('mousemove', (e) => {
    targetMouse.x = (e.clientX / window.innerWidth)  * 2 - 1;
    targetMouse.y = (e.clientY / window.innerHeight) * 2 - 1;
});

// ── Model references ─────────────────────────────────────────────────
let model = null;
let originalColors = [];
const wireframeGroup = new THREE.Group();  // holds wireframe + edge overlays
scene.add(wireframeGroup);

// ── Custom Smooth Loader ─────────────────────────────────────────────
let targetProgress = 0;
let currentProgress = 0;
let loaderFinished = false;

function updateLoader() {
    if (loaderFinished) return;

    currentProgress += (targetProgress - currentProgress) * 0.08;
    if (targetProgress === 100 && targetProgress - currentProgress < 0.5) {
        currentProgress = 100;
    }

    const progressEl = document.querySelector('.loader-progress');
    if (progressEl) {
        progressEl.textContent = `${Math.round(currentProgress)}%`;
    }

    if (currentProgress === 100) {
        loaderFinished = true;
        const loaderEl = document.getElementById('loader');
        if (loaderEl) {
            loaderEl.style.opacity = '0';
            loaderEl.style.visibility = 'hidden';
            setTimeout(() => loaderEl.remove(), 1200);
        }
        return;
    }
    requestAnimationFrame(updateLoader);
}
requestAnimationFrame(updateLoader);

// ── Load model ───────────────────────────────────────────────────────
const loader = new GLTFLoader();
loader.load(
    './stone church 3d model.glb',
    (gltf) => {
        model = gltf.scene;

        // Setup original model
        model.traverse((child) => {
            if (child.isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;
                if (child.material && child.material.color) {
                    originalColors.push({ mesh: child, color: child.material.color.clone() });
                }
                injectXRayShader(child.material);
            }
        });

        // Center and position
        const box = new THREE.Box3().setFromObject(model);
        const center = box.getCenter(new THREE.Vector3());
        model.position.x = -center.x;
        model.position.y = -box.min.y;
        model.position.z = -center.z;
        model.rotation.y = THREE.MathUtils.degToRad(params.modelRotY);
        scene.add(model);

        // Force matrixWorld update after positioning
        model.updateMatrixWorld(true);

        // Collect model meshes for CPU raycasting and generate BVH
        model.traverse((child) => {
            if (child.isMesh) {
                if (!child.geometry.boundsTree) {
                    child.geometry.computeBoundsTree();
                }
                modelMeshes.push(child);
            }
        });

        // ── Build wireframe + edge overlays ──────────────────────────
        model.traverse((child) => {
            if (!child.isMesh || !child.geometry) return;

            const geo = child.geometry.clone();
            geo.applyMatrix4(child.matrixWorld);

            const edgesGeo = new THREE.EdgesGeometry(geo, params.edgeThresholdAngle);
            const edgeLines = new THREE.LineSegments(edgesGeo, edgeRevealMat);
            edgeLines.renderOrder = 2;
            wireframeGroup.add(edgeLines);

            geo.dispose(); 
        });

        applyModelTint();
        applyCamera();
        keyLight.target.position.set(0, params.lookAtY, 0);
        keyLight.target.updateMatrixWorld();

        // Sinaliza para o animador do loader ir até 100%
        targetProgress = 100;
    },
    (xhr) => {
        if (xhr.total > 0) {
            targetProgress = Math.max(targetProgress, (xhr.loaded / xhr.total) * 100);
        }
    },
    (err) => console.error('GLTFLoader error:', err)
);

// ── Scroll Parallax ──────────────────────────────────────────────────
let targetScrollPercent = 0;
let currentScrollPercent = 0;

const updateScrollTarget = () => {
    const scrollY = window.scrollY;
    const maxScroll = Math.max(1, document.body.scrollHeight - window.innerHeight);
    targetScrollPercent = scrollY / maxScroll;
};
window.addEventListener('scroll', updateScrollTarget);
updateScrollTarget();

// ── Helpers ──────────────────────────────────────────────────────────
function applyCamera() {
    camera.fov = params.camFOV;
    camera.updateProjectionMatrix();
}
function applyModelTint() {
    const tintColor = new THREE.Color(params.modelColorTint);
    originalColors.forEach(({ mesh, color }) => {
        mesh.material.color.copy(color).lerp(tintColor, params.modelTintStrength);
        mesh.material.needsUpdate = true;
    });
}

// ── GUI ──────────────────────────────────────────────────────────────
const gui = new GUI({ width: 320, title: '⚙ Scene Controls' });
gui.hide(); // Ocultando os controles por enquanto

const camF = gui.addFolder('📷 Camera');
camF.add(params, 'camX', -50, 50, 0.1).name('X');
camF.add(params, 'camY', -20, 50, 0.1).name('Y');
camF.add(params, 'camZ', -50, 50, 0.1).name('Z');
camF.add(params, 'camFOV', 10, 90, 1).name('FOV').onChange(applyCamera);
camF.add(params, 'lookAtY', -10, 20, 0.1).name('Look-At Y');

const modF = gui.addFolder('🏛 Model');
modF.add(params, 'modelRotY', 0, 360, 1).name('Rotation Y°').onChange(() => {
    if (model) model.rotation.y = THREE.MathUtils.degToRad(params.modelRotY);
});
modF.add(params, 'modelScale', 0.1, 5, 0.01).name('Scale').onChange(() => {
    if (model) model.scale.setScalar(params.modelScale);
});
modF.addColor(params, 'modelColorTint').name('Color Tint').onChange(applyModelTint);
modF.add(params, 'modelTintStrength', 0, 1, 0.01).name('Tint Strength').onChange(applyModelTint);

const keyF = gui.addFolder('☀ Key Light');
keyF.add(params, 'keyIntensity', 0, 10, 0.1).name('Intensity').onChange(() => keyLight.intensity = params.keyIntensity);
keyF.add(params, 'keyX', -50, 50, 0.5).name('X').onChange(() => keyLight.position.x = params.keyX);
keyF.add(params, 'keyY', 0, 60, 0.5).name('Y').onChange(() => keyLight.position.y = params.keyY);
keyF.add(params, 'keyZ', -50, 50, 0.5).name('Z').onChange(() => keyLight.position.z = params.keyZ);
keyF.addColor(params, 'keyColor').name('Color').onChange(() => keyLight.color.set(params.keyColor));
keyF.add(params, 'shadowRadius', 0, 20, 0.5).name('Shadow Softness').onChange(() => keyLight.shadow.radius = params.shadowRadius);

const filF = gui.addFolder('💡 Fill Light');
filF.add(params, 'fillIntensity', 0, 5, 0.1).name('Intensity').onChange(() => fillLight.intensity = params.fillIntensity);
filF.add(params, 'fillX', -50, 50, 0.5).name('X').onChange(() => fillLight.position.x = params.fillX);
filF.add(params, 'fillY', -20, 50, 0.5).name('Y').onChange(() => fillLight.position.y = params.fillY);
filF.add(params, 'fillZ', -50, 50, 0.5).name('Z').onChange(() => fillLight.position.z = params.fillZ);
filF.addColor(params, 'fillColor').name('Color').onChange(() => fillLight.color.set(params.fillColor));

const rimF = gui.addFolder('✨ Rim Light');
rimF.add(params, 'rimIntensity', 0, 5, 0.1).name('Intensity').onChange(() => rimLight.intensity = params.rimIntensity);
rimF.add(params, 'rimX', -50, 50, 0.5).name('X').onChange(() => rimLight.position.x = params.rimX);
rimF.add(params, 'rimY', -20, 50, 0.5).name('Y').onChange(() => rimLight.position.y = params.rimY);
rimF.add(params, 'rimZ', -50, 50, 0.5).name('Z').onChange(() => rimLight.position.z = params.rimZ);
rimF.addColor(params, 'rimColor').name('Color').onChange(() => rimLight.color.set(params.rimColor));

const envF = gui.addFolder('🌍 Environment');
envF.add(params, 'ambientIntensity', 0, 3, 0.05).name('Ambient Int.').onChange(() => ambientLight.intensity = params.ambientIntensity);
envF.addColor(params, 'ambientColor').name('Ambient Color').onChange(() => ambientLight.color.set(params.ambientColor));
envF.add(params, 'hemiIntensity', 0, 3, 0.05).name('Hemi Int.').onChange(() => hemiLight.intensity = params.hemiIntensity);
envF.addColor(params, 'hemiSkyColor').name('Hemi Sky').onChange(() => hemiLight.color.set(params.hemiSkyColor));
envF.addColor(params, 'hemiGroundColor').name('Hemi Ground').onChange(() => hemiLight.groundColor.set(params.hemiGroundColor));

const bgF = gui.addFolder('🎨 Colors');
bgF.addColor(params, 'bgColor').name('Background').onChange(() => {
    document.body.style.backgroundColor = params.bgColor;
});
bgF.addColor(params, 'floorColor').name('Floor').onChange(() => floorMat.color.set(params.floorColor));

const postF = gui.addFolder('🎬 Tone Mapping');
postF.add(params, 'toneMapping', Object.keys(toneMappingOptions)).name('Algorithm').onChange(applyToneMapping);
postF.add(params, 'exposure', 0.1, 5, 0.05).name('Exposure').onChange(applyToneMapping);

const parF = gui.addFolder('🖱 Parallax');
parF.add(params, 'parallaxEnabled').name('Enabled');
parF.add(params, 'parallaxStrength', 0, 3, 0.05).name('Strength');

const hovF = gui.addFolder('🔲 Hover X-Ray & Floor');
hovF.add(params, 'hoverEnabled').name('Enabled');
hovF.add(params, 'hoverRadiusChurch', 0.1, 3.0, 0.01).name('Radius Church').onChange(() => {
    hoverUniforms.uRadiusChurch.value = params.hoverRadiusChurch;
});
hovF.add(params, 'hoverRadiusFloor', 0.1, 5.0, 0.1).name('Radius Floor').onChange(() => {
    hoverUniforms.uRadiusFloor.value = params.hoverRadiusFloor;
});
hovF.addColor(params, 'xrayColor').name('X-Ray Color').onChange(() => {
    hoverUniforms.uXrayColor.value.set(params.xrayColor);
});
hovF.add(params, 'xrayOpacity', 0, 1, 0.01).name('X-Ray Opacity').onChange(() => {
    hoverUniforms.uXrayOpacity.value = params.xrayOpacity;
});
hovF.addColor(params, 'edgeColor').name('Edge Color').onChange(() => {
    edgeRevealMat.uniforms.uColor.value.set(params.edgeColor);
});
hovF.add(params, 'edgeOpacity', 0, 1, 0.01).name('Edge Opacity').onChange(() => {
    edgeRevealMat.uniforms.uOpacity.value = params.edgeOpacity;
});
hovF.addColor(params, 'floorGridColor').name('Floor Grid Color').onChange(() => {
    floorGridMat.uniforms.uColor.value.set(params.floorGridColor);
});
hovF.add(params, 'floorGridOpacity', 0, 1, 0.01).name('Floor Grid Opacity').onChange(() => {
    floorGridMat.uniforms.uOpacity.value = params.floorGridOpacity;
});

gui.add(params, 'exportSettings').name('📋 Copy Settings JSON');

// Collapse most folders
[camF, modF, filF, rimF, envF, bgF, postF, parF].forEach(f => f.close());

// ── Resize ───────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    hoverUniforms.uResolution.value.set(window.innerWidth * dpr, window.innerHeight * dpr);
});

// ── Smoothed hit state ───────────────────────────────────────────────
const currentHitPoint = new THREE.Vector3(0, -999, 0);
const smoothHitPoint  = new THREE.Vector3(0, -999, 0);
let hitActive = 0;

// ── Render loop ──────────────────────────────────────────────────────
function animate(time = 0) {
    requestAnimationFrame(animate);
    hoverUniforms.uTime.value = time * 0.001;

    // Parallax Mouse
    if (params.parallaxEnabled) {
        mouse.x += (targetMouse.x - mouse.x) * 0.04;
        mouse.y += (targetMouse.y - mouse.y) * 0.04;
    }

    // ── Smooth Scroll Interp ─────────────────────────────────────────
    currentScrollPercent += (targetScrollPercent - currentScrollPercent) * 0.03;

    // FASE 1: (0.0 até 0.5) - Parallax do Letreiro & Subtle Zoom
    const p1 = Math.min(1, currentScrollPercent * 2);
    const bgText = document.getElementById('bg-text');
    if (bgText) {
        bgText.style.transform = `translateY(-50%) translateX(calc(100vw - (100vw + 100%) * ${p1}))`;
    }

    // Breathing Zoom Effect (+5% e -5%) durante a Fase 1
    // Modificamos o FOV suavemente em forma de onda completa (0 -> zoom in -> 0 -> zoom out -> 0)
    let currentFov = params.camFOV;
    const zoomAmount = params.camFOV * 0.05; 
    currentFov = params.camFOV - Math.sin(p1 * Math.PI * 2) * zoomAmount;
    
    if (Math.abs(camera.fov - currentFov) > 0.001) {
        camera.fov = currentFov;
        camera.updateProjectionMatrix();
    }

    // FASE 2: (0.5 até 1.0) - Drone Camera & Text Centering
    const p2 = Math.max(0, (currentScrollPercent - 0.5) * 2);

    // Câmera interpola para posição de drone
    let camX = params.camX;
    let camY = params.camY;
    let camZ = params.camZ;
    let lookY = params.lookAtY;

    if (params.parallaxEnabled) {
        camX += mouse.x * params.parallaxStrength;
        camY -= mouse.y * params.parallaxStrength * 0.4;
    }

    // Posição final (drone)
    const targetCamX = 0;
    const targetCamY = 22; // Bem alto
    const targetCamZ = 2;  // Ligeiramente inclinado
    const targetLookY = 0;

    camera.position.set(
        camX + (targetCamX - camX) * p2,
        camY + (targetCamY - camY) * p2,
        camZ + (targetCamZ - camZ) * p2
    );
    camera.lookAt(0, lookY + (targetLookY - lookY) * p2, 0);

    // Textos de rodapé se centralizam
    const h1 = document.getElementById('bottom-h1');
    const h2 = document.getElementById('bottom-h2');
    if (h1 && h2) {
        // H1 desliza para o centro superior
        h1.style.left = `calc(3rem + (50vw - 3rem) * ${p2})`;
        h1.style.bottom = `calc(3rem + (50vh + 3rem - 3rem) * ${p2})`; // Sobe um pouco acima do centro
        h1.style.transform = `translate(-${50 * p2}%, 0)`;
        if(p2 > 0) h1.style.textAlign = 'center'; else h1.style.textAlign = 'left';

        // H2 desliza para o centro inferior
        h2.style.right = `calc(3rem + (50vw - 3rem) * ${p2})`;
        h2.style.bottom = `calc(3rem + (50vh - 3rem - 3rem) * ${p2})`; // Desce um pouco abaixo do centro
        h2.style.transform = `translate(${50 * p2}%, 0)`;
        if(p2 > 0) h2.style.textAlign = 'center'; else h2.style.textAlign = 'right';
    }

    // White Overlay Fade-In (Começa a aparecer no final do scroll, p2 > 0.6)
    const whiteOverlay = document.getElementById('white-overlay');
    if (whiteOverlay) {
        const overlayP = Math.max(0, (p2 - 0.6) / 0.4);
        whiteOverlay.style.opacity = overlayP;
    }

    if (params.hoverEnabled) {
        // Instant 3D Raycast using BVH
        raycaster.setFromCamera(mouseNDC, camera);
        const hits = raycaster.intersectObjects([...modelMeshes, floor], false);
        if (hits.length > 0) {
            currentHitPoint.copy(hits[0].point);
            hitActive = 1;
        } else {
            hitActive = 0;
        }
        
        smoothHitPoint.lerp(currentHitPoint, 0.15);
        hoverUniforms.uHitPoint.value.copy(smoothHitPoint);
        hoverUniforms.uActive.value += (hitActive - hoverUniforms.uActive.value) * 0.12;
        
        hoverUniforms.uRadiusChurch.value = params.hoverRadiusChurch;
        hoverUniforms.uRadiusFloor.value = params.hoverRadiusFloor;

        // Pass 2D Mouse for the liquid wobble angle
        smoothMouse.lerp(pixelMouse, 0.25);
        hoverUniforms.uMouse.value.copy(smoothMouse);
    } else {
        hoverUniforms.uActive.value *= 0.9;
        if (hoverUniforms.uActive.value < 0.001) hoverUniforms.uActive.value = 0;
    }

    renderer.render(scene, camera);
}

animate();
