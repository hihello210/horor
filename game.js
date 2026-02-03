import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
import { PointerLockControls } from "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/PointerLockControls.js";

const overlay = document.getElementById("overlay");
const startButton = document.getElementById("startButton");
const statusLabel = document.getElementById("status");
const timerLabel = document.getElementById("timer");
const flash = document.getElementById("flash");

let scene;
let camera;
let renderer;
let controls;
let clock;
let hallwaySegments = [];
let hallwayGroup;
let stalker;
let stalkerSpeed = 1.5;
let stalkerSpeedMultiplier = 1;
let screamCooldown = 0;
let nextEchoTimer = 30;

let audioContext;
let listener;
let micStream;
let mediaRecorder;
let analyser;
let micDataArray;
let latestChunks = [];
let isRecordingReady = false;
let lastEchoTime = 0;

const hallwayConfig = {
  segmentLength: 40,
  segmentCount: 10,
  width: 12,
  height: 7,
};

const movement = {
  forward: false,
  backward: false,
  left: false,
  right: false,
  speed: 6,
};

const flickerLights = [];

init();

function init() {
  scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x020207, 6, 75);

  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 200);
  camera.position.set(0, 2, 5);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  document.body.appendChild(renderer.domElement);

  controls = new PointerLockControls(camera, document.body);

  clock = new THREE.Clock();

  const ambient = new THREE.AmbientLight(0x2b2b2b, 0.3);
  scene.add(ambient);

  hallwayGroup = new THREE.Group();
  scene.add(hallwayGroup);
  createHallwaySegments();

  stalker = new THREE.Object3D();
  stalker.position.set(0, 1.5, -20);
  scene.add(stalker);

  window.addEventListener("resize", onWindowResize);
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("keyup", onKeyUp);

  startButton.addEventListener("click", async () => {
    overlay.style.display = "none";
    controls.lock();
    await setupAudio();
  });

  animate();
}

function createHallwaySegments() {
  const { segmentLength, segmentCount, width, height } = hallwayConfig;
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x0d0d12, roughness: 0.9 });
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x15151d, roughness: 0.8 });
  const ceilingMat = new THREE.MeshStandardMaterial({ color: 0x0b0b10, roughness: 1 });

  for (let i = 0; i < segmentCount; i += 1) {
    const segmentGroup = new THREE.Group();
    const zOffset = -i * segmentLength;

    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(width, 0.5, segmentLength),
      floorMat
    );
    floor.position.set(0, 0, zOffset - segmentLength / 2);

    const ceiling = new THREE.Mesh(
      new THREE.BoxGeometry(width, 0.5, segmentLength),
      ceilingMat
    );
    ceiling.position.set(0, height, zOffset - segmentLength / 2);

    const leftWall = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, height, segmentLength),
      wallMat
    );
    leftWall.position.set(-width / 2, height / 2, zOffset - segmentLength / 2);

    const rightWall = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, height, segmentLength),
      wallMat
    );
    rightWall.position.set(width / 2, height / 2, zOffset - segmentLength / 2);

    segmentGroup.add(floor, ceiling, leftWall, rightWall);

    const flicker = new THREE.PointLight(0x7b2828, 0.7, 18, 2);
    flicker.position.set(0, height - 1, zOffset - segmentLength / 2);
    segmentGroup.add(flicker);
    flickerLights.push({ light: flicker, base: 0.7, phase: Math.random() * Math.PI * 2 });

    hallwayGroup.add(segmentGroup);
    hallwaySegments.push({ group: segmentGroup, zOffset });
  }
}

function recycleHallway() {
  const { segmentLength, segmentCount } = hallwayConfig;
  const playerZ = controls.getObject().position.z;
  const deepestSegment = hallwaySegments.reduce((min, seg) => (seg.zOffset < min.zOffset ? seg : min), hallwaySegments[0]);
  const frontSegment = hallwaySegments.reduce((max, seg) => (seg.zOffset > max.zOffset ? seg : max), hallwaySegments[0]);

  if (playerZ < deepestSegment.zOffset - segmentLength * 2) {
    const newZ = frontSegment.zOffset - segmentLength;
    deepestSegment.zOffset = newZ;
    deepestSegment.group.position.z = newZ;
  }

  if (playerZ > frontSegment.zOffset + segmentLength) {
    const newZ = deepestSegment.zOffset + segmentLength;
    frontSegment.zOffset = newZ;
    frontSegment.group.position.z = newZ;
  }

  hallwaySegments.forEach((segment) => {
    segment.group.position.z = segment.zOffset;
  });
}

async function setupAudio() {
  try {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    listener = new THREE.AudioListener();
    camera.add(listener);

    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

    const source = audioContext.createMediaStreamSource(micStream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    micDataArray = new Uint8Array(analyser.fftSize);
    source.connect(analyser);

    mediaRecorder = new MediaRecorder(micStream);

    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) {
        latestChunks.push(event.data);
        if (latestChunks.length > 6) {
          latestChunks.shift();
        }
        isRecordingReady = true;
      }
    });

    mediaRecorder.start(5000);

    statusLabel.textContent = "Mic: live";
  } catch (error) {
    statusLabel.textContent = "Mic: blocked";
    console.error("Microphone error:", error);
  }
}

function playEcho() {
  if (!isRecordingReady || latestChunks.length === 0 || !audioContext) {
    return;
  }

  const chunk = latestChunks[latestChunks.length - 1];
  const reader = new FileReader();

  reader.onload = async () => {
    const arrayBuffer = reader.result;
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

    const echo = new THREE.PositionalAudio(listener);
    echo.setBuffer(audioBuffer);
    echo.setRefDistance(4);
    echo.setRolloffFactor(2);
    echo.setVolume(0.9);
    echo.playbackRate = 0.8;

    const randomAngle = Math.random() * Math.PI * 2;
    const randomRadius = 6 + Math.random() * 6;
    const offsetX = Math.cos(randomAngle) * randomRadius;
    const offsetZ = Math.sin(randomAngle) * randomRadius;

    echo.position.set(
      controls.getObject().position.x + offsetX,
      1.5,
      controls.getObject().position.z + offsetZ
    );

    scene.add(echo);
    echo.play();

    setTimeout(() => {
      scene.remove(echo);
    }, audioBuffer.duration * 1000 + 2000);
  };

  reader.readAsArrayBuffer(chunk);
}

function monitorScream(delta) {
  if (!analyser) {
    return;
  }

  analyser.getByteTimeDomainData(micDataArray);
  let sumSquares = 0;

  for (let i = 0; i < micDataArray.length; i += 1) {
    const centered = (micDataArray[i] - 128) / 128;
    sumSquares += centered * centered;
  }

  const rms = Math.sqrt(sumSquares / micDataArray.length);
  const threshold = 0.35;

  if (rms > threshold && screamCooldown <= 0) {
    flash.classList.add("active");
    setTimeout(() => flash.classList.remove("active"), 200);
    stalkerSpeedMultiplier = 2;
    screamCooldown = 4;
  }

  if (screamCooldown > 0) {
    screamCooldown -= delta;
    if (screamCooldown <= 0) {
      stalkerSpeedMultiplier = 1;
    }
  }
}

function updateStalker(delta) {
  const playerPos = controls.getObject().position;
  const direction = new THREE.Vector3().subVectors(playerPos, stalker.position);
  const distance = direction.length();

  if (distance > 0.5) {
    direction.normalize();
    const speed = stalkerSpeed * stalkerSpeedMultiplier;
    stalker.position.addScaledVector(direction, speed * delta);
  }
}

function animate() {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();

  if (controls.isLocked) {
    const velocity = new THREE.Vector3();
    if (movement.forward) velocity.z -= 1;
    if (movement.backward) velocity.z += 1;
    if (movement.left) velocity.x -= 1;
    if (movement.right) velocity.x += 1;
    velocity.normalize();
    velocity.multiplyScalar(movement.speed * delta);
    controls.moveRight(velocity.x);
    controls.moveForward(velocity.z);
  }

  recycleHallway();

  flickerLights.forEach((item) => {
    item.phase += delta * (1.5 + Math.random() * 0.5);
    item.light.intensity = item.base + Math.sin(item.phase) * 0.3 + (Math.random() - 0.5) * 0.2;
  });

  monitorScream(delta);
  updateStalker(delta);

  const elapsed = clock.elapsedTime;
  if (elapsed - lastEchoTime >= 30) {
    playEcho();
    lastEchoTime = elapsed;
  }
  nextEchoTimer = Math.max(0, 30 - (elapsed - lastEchoTime));
  timerLabel.textContent = `Next Echo: ${nextEchoTimer.toFixed(0)}s`;

  renderer.render(scene, camera);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function onKeyDown(event) {
  switch (event.code) {
    case "KeyW":
      movement.forward = true;
      break;
    case "KeyS":
      movement.backward = true;
      break;
    case "KeyA":
      movement.left = true;
      break;
    case "KeyD":
      movement.right = true;
      break;
    default:
      break;
  }
}

function onKeyUp(event) {
  switch (event.code) {
    case "KeyW":
      movement.forward = false;
      break;
    case "KeyS":
      movement.backward = false;
      break;
    case "KeyA":
      movement.left = false;
      break;
    case "KeyD":
      movement.right = false;
      break;
    default:
      break;
  }
}
