import React, { Suspense, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Environment, Html, OrbitControls, Text } from "@react-three/drei";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { io } from "socket.io-client";
import * as THREE from "three";
import { Code2, Globe2, MessageCircle, Plus, Save, Send, Upload, Users, Video, X } from "lucide-react";
import "./styles.css";

const socket = io(import.meta.env.VITE_SOCKET_URL || "http://localhost:3001", {
  autoConnect: false,
  transports: ["websocket", "polling"],
});
const API_BASE = import.meta.env.VITE_SOCKET_URL || "http://localhost:3001";

const MOVEMENT_SPEED = 3.2;
const TURN_SPEED = 3.8;
const START_POSITION = { x: 0, y: 0, z: 0 };
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const AVATAR_FORWARD_OFFSET = Math.PI;

function App() {
  const [selfId, setSelfId] = useState("");
  const [profile, setProfile] = useState(() => ({
    name: `Guest-${Math.floor(Math.random() * 900 + 100)}`,
    color: randomColor(),
    avatarUrl: "",
  }));
  const profileRef = useRef(profile);
  const [players, setPlayers] = useState({});
  const [messages, setMessages] = useState([]);
  const [previewVrmUrl, setPreviewVrmUrl] = useState("");
  const [connected, setConnected] = useState(socket.connected);
  const [worlds, setWorlds] = useState([]);
  const [currentWorldId, setCurrentWorldId] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const currentWorldIdRef = useRef("");
  const localPoseRef = useRef({
    position: START_POSITION,
    rotationY: AVATAR_FORWARD_OFFSET,
    animation: "idle",
  });
  const pendingPoseRef = useRef(null);
  const lastSentPoseRef = useRef(null);

  React.useEffect(() => {
    profileRef.current = profile;
  }, [profile]);

  React.useEffect(() => {
    currentWorldIdRef.current = currentWorldId;
  }, [currentWorldId]);

  React.useEffect(() => {
    const sendPlayerSet = () => {
      const pose = pendingPoseRef.current;
      if (!pose || !socket.connected) return;

      const lastPose = lastSentPoseRef.current;
      const animationChanged = pose.animation !== lastPose?.animation;
      const distanceMoved = lastPose
        ? Math.hypot(pose.position.x - lastPose.position.x, pose.position.z - lastPose.position.z)
        : Number.POSITIVE_INFINITY;
      const turned = lastPose ? Math.abs(Math.atan2(Math.sin(pose.rotationY - lastPose.rotationY), Math.cos(pose.rotationY - lastPose.rotationY))) : 1;

      if (!animationChanged && distanceMoved < 0.025 && turned < 0.015) return;

      const payload = {
        position: { ...pose.position },
        rotationY: pose.rotationY,
        animation: pose.animation,
      };

      if (animationChanged) {
        socket.emit("player:update", payload);
      } else {
        socket.volatile.emit("player:update", payload);
      }

      lastSentPoseRef.current = payload;
    };

    const interval = window.setInterval(sendPlayerSet, 50);
    return () => window.clearInterval(interval);
  }, []);

  React.useEffect(() => {
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);

    const onInit = (payload) => {
      const { selfId: id, players: remotePlayers, chat } = payload;
      const initialWorlds = payload?.worlds || [];
      const activeWorldId = payload?.activeWorldId || initialWorlds[0]?.id || "";
      setSelfId(id);
      setWorlds(initialWorlds);
      setCurrentWorldId(activeWorldId);
      currentWorldIdRef.current = activeWorldId;
      setMessages(chat || []);
      setPlayers(Object.fromEntries((remotePlayers || []).map((player) => [player.id, player])));
      socket.emit("player:join", {
        ...profileRef.current,
        worldId: activeWorldId,
        position: START_POSITION,
        rotationY: AVATAR_FORWARD_OFFSET,
        animation: "idle",
      });
    };

    const upsert = (player) => {
      setPlayers((current) => ({ ...current, [player.id]: player }));
    };

    const remove = (id) => {
      setPlayers((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    };

    const onMessage = (message) => {
      setMessages((current) => [...current.slice(-79), message]);
    };

    const onWorldState = ({ worldId, players: worldPlayers, chat }) => {
      setCurrentWorldId(worldId);
      currentWorldIdRef.current = worldId;
      setPlayers(Object.fromEntries((worldPlayers || []).map((player) => [player.id, player])));
      setMessages(chat || []);
    };

    const onWorldsUpdated = (nextWorlds) => {
      setWorlds(nextWorlds || []);
    };

    const onWorldUpdated = (world) => {
      setWorlds((current) => current.map((item) => (item.id === world.id ? world : item)));
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("world:init", onInit);
    socket.on("world:state", onWorldState);
    socket.on("worlds:updated", onWorldsUpdated);
    socket.on("world:updated", onWorldUpdated);
    socket.on("player:accepted", upsert);
    socket.on("player:joined", upsert);
    socket.on("player:updated", upsert);
    socket.on("player:left", remove);
    socket.on("chat:message", onMessage);
    socket.connect();

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("world:init", onInit);
      socket.off("world:state", onWorldState);
      socket.off("worlds:updated", onWorldsUpdated);
      socket.off("world:updated", onWorldUpdated);
      socket.off("player:accepted", upsert);
      socket.off("player:joined", upsert);
      socket.off("player:updated", upsert);
      socket.off("player:left", remove);
      socket.off("chat:message", onMessage);
      socket.disconnect();
    };
  }, []);

  const updateProfile = (nextProfile) => {
    setProfile(nextProfile);
    socket.emit("player:join", {
      ...nextProfile,
      worldId: currentWorldIdRef.current,
      ...localPoseRef.current,
    });
  };

  const uploadAvatar = async (file) => {
    const previewUrl = URL.createObjectURL(file);
    setPreviewVrmUrl(previewUrl);

    const response = await fetch(`${API_BASE}/api/avatar`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: await file.arrayBuffer(),
    });

    if (!response.ok) {
      throw new Error("VRM upload failed");
    }

    const { url } = await response.json();
    updateProfile({ ...profileRef.current, avatarUrl: url });
    setPreviewVrmUrl(url);
  };

  const localPlayer = players[selfId];
  const remotePlayers = Object.values(players).filter((player) => player.id !== selfId);
  const currentWorld = worlds.find((world) => world.id === currentWorldId) || worlds[0];

  const changeWorld = (worldId) => {
    const world = worlds.find((item) => item.id === worldId);
    if (!world) return;
    setCurrentWorldId(world.id);
    currentWorldIdRef.current = world.id;
    setPlayers({});
    setMessages([]);
    localPoseRef.current = {
      position: START_POSITION,
      rotationY: AVATAR_FORWARD_OFFSET,
      animation: "idle",
    };
    pendingPoseRef.current = null;
    lastSentPoseRef.current = null;
    socket.emit("player:join", {
      ...profileRef.current,
      worldId: world.id,
      position: START_POSITION,
      rotationY: AVATAR_FORWARD_OFFSET,
      animation: "idle",
    });
  };

  const createWorld = async () => {
    const name = `World ${worlds.length + 1}`;
    const response = await fetch(`${API_BASE}/api/worlds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const { world } = await response.json();
    setWorlds((current) => [...current, world]);
    setCurrentWorldId(world.id);
    currentWorldIdRef.current = world.id;
    setPlayers({});
    setMessages([]);
    localPoseRef.current = {
      position: START_POSITION,
      rotationY: AVATAR_FORWARD_OFFSET,
      animation: "idle",
    };
    pendingPoseRef.current = null;
    lastSentPoseRef.current = null;
    socket.emit("player:join", {
      ...profileRef.current,
      worldId: world.id,
      position: START_POSITION,
      rotationY: AVATAR_FORWARD_OFFSET,
      animation: "idle",
    });
    setEditorOpen(true);
  };

  const saveWorld = async (nextWorld) => {
    const response = await fetch(`${API_BASE}/api/worlds/${nextWorld.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: nextWorld.name, script: nextWorld.script }),
    });
    const { world } = await response.json();
    setWorlds((current) => current.map((item) => (item.id === world.id ? world : item)));
  };

  const playerSet = React.useCallback((payload) => {
    localPoseRef.current = payload;
    pendingPoseRef.current = payload;
  }, []);

  return (
    <main className="app-shell">
      <Canvas shadows camera={{ position: [0, 4.4, 7.5], fov: 48 }}>
        <color attach="background" args={["#b9d8e8"]} />
        <fog attach="fog" args={["#b9d8e8", 14, 46]} />
        <Suspense fallback={null}>
          <World world={currentWorld} />
          <LocalAvatar
            key={currentWorldId}
            player={localPlayer || { ...profile, id: selfId, position: START_POSITION }}
            vrmUrl={previewVrmUrl || profile.avatarUrl}
            onMove={playerSet}
          />
          {remotePlayers.map((player) => (
            <RemoteAvatar key={player.id} player={player} />
          ))}
          <Environment preset="city" />
        </Suspense>
      </Canvas>

      <TopBar
        profile={profile}
        connected={connected}
        playerCount={Object.keys(players).length}
        onProfileChange={updateProfile}
        onVrmFile={uploadAvatar}
        worlds={worlds}
        currentWorldId={currentWorldId}
        onWorldChange={changeWorld}
        onCreateWorld={createWorld}
        onOpenEditor={() => setEditorOpen(true)}
      />
      {editorOpen && currentWorld ? (
        <WorldEditor world={currentWorld} onClose={() => setEditorOpen(false)} onSave={saveWorld} />
      ) : null}
      <ChatPanel profile={profile} messages={messages} onSend={(text) => socket.emit("chat:send", { text })} />
      <div className="movement-hint">WASD / 矢印キーで移動、マウスで視点操作</div>
    </main>
  );
}

function World({ world }) {
  return (
    <>
      <ambientLight intensity={0.68} />
      <directionalLight
        castShadow
        intensity={1.9}
        position={[8, 12, 5]}
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
      />
      <mesh receiveShadow rotation-x={-Math.PI / 2}>
        <circleGeometry args={[42, 96]} />
        <meshStandardMaterial color="#6fb67c" roughness={0.8} />
      </mesh>
      <mesh receiveShadow rotation-x={-Math.PI / 2} position={[0, 0.01, 0]}>
        <ringGeometry args={[5.8, 6.05, 96]} />
        <meshStandardMaterial color="#e6d8aa" roughness={0.9} />
      </mesh>
      <group>
        {Array.from({ length: 20 }).map((_, index) => {
          const angle = (index / 20) * Math.PI * 2;
          const radius = 10 + (index % 4) * 1.3;
          return (
            <Tree
              key={index}
              position={[Math.cos(angle) * radius, 0, Math.sin(angle) * radius]}
              scale={0.85 + (index % 5) * 0.12}
            />
          );
        })}
      </group>
      <ScriptedWorld world={world} />
    </>
  );
}

function ScriptedWorld({ world }) {
  const { objects, error } = useMemo(() => buildWorldObjects(world?.script || ""), [world?.script]);

  return (
    <group>
      {objects.map((object) => (
        <WorldObject key={object.id} object={object} />
      ))}
      {error ? (
        <Html center position={[0, 2.2, 0]} className="script-error-bubble">
          <div>{error}</div>
        </Html>
      ) : null}
    </group>
  );
}

function WorldObject({ object }) {
  const position = object.position || [0, 0, 0];
  const rotation = object.rotation || [0, 0, 0];
  const scale = object.scale || [1, 1, 1];

  if (object.type === "tree") {
    return <Tree position={position} scale={Array.isArray(scale) ? scale[0] : scale} />;
  }

  if (object.type === "sign") {
    return (
      <Text
        position={position}
        rotation={rotation.length ? rotation : [-Math.PI / 2, 0, 0]}
        fontSize={object.size || 0.38}
        color={object.color || "#1d3557"}
        anchorX="center"
        anchorY="middle"
      >
        {object.text || ""}
      </Text>
    );
  }

  const material = <meshStandardMaterial color={object.color || "#d6e6ef"} roughness={0.72} metalness={0.02} />;

  if (object.type === "cylinder") {
    return (
      <mesh castShadow receiveShadow position={position} rotation={rotation}>
        <cylinderGeometry args={[object.radiusTop || 0.5, object.radiusBottom || 0.5, object.height || 1, 24]} />
        {material}
      </mesh>
    );
  }

  if (object.type === "sphere") {
    return (
      <mesh castShadow receiveShadow position={position} rotation={rotation} scale={scale}>
        <sphereGeometry args={[object.radius || 0.5, 32, 18]} />
        {material}
      </mesh>
    );
  }

  return (
    <mesh castShadow receiveShadow position={position} rotation={rotation}>
      <boxGeometry args={scale} />
      {material}
    </mesh>
  );
}

function buildWorldObjects(script) {
  const objects = [];
  const usedIds = new Set();
  const add = (type, config = {}) => {
    const id = String(config.id || `${type}-${objects.length + 1}`).slice(0, 80);
    const uniqueId = usedIds.has(id) ? `${id}-${objects.length + 1}` : id;
    usedIds.add(uniqueId);
    objects.push({
      ...config,
      id: uniqueId,
      type,
      position: vector3(config.position, [0, 0, 0]),
      rotation: vector3(config.rotation, [0, 0, 0]),
      scale: type === "tree" ? config.scale || 1 : vector3(config.scale || config.size3, [1, 1, 1]),
    });
  };

  const api = Object.freeze({
    box: (config) => add("box", config),
    platform: (config) => add("box", config),
    wall: (config) => add("box", config),
    cylinder: (config) => add("cylinder", config),
    sphere: (config) => add("sphere", config),
    tree: (config) => add("tree", config),
    sign: (config) => add("sign", config),
  });

  try {
    const run = new Function("verse", `"use strict";\nconst api = verse.api;\n${script}`);
    run(Object.freeze({ api, Math }));
    return { objects, error: "" };
  } catch (error) {
    return { objects, error: error instanceof Error ? error.message : "Script error" };
  }
}

function vector3(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  return [
    Number.isFinite(Number(value[0])) ? Number(value[0]) : fallback[0],
    Number.isFinite(Number(value[1])) ? Number(value[1]) : fallback[1],
    Number.isFinite(Number(value[2])) ? Number(value[2]) : fallback[2],
  ];
}

function Tree({ position, scale }) {
  return (
    <group position={position} scale={scale}>
      <mesh castShadow position={[0, 0.55, 0]}>
        <cylinderGeometry args={[0.16, 0.22, 1.1, 8]} />
        <meshStandardMaterial color="#8a5a35" />
      </mesh>
      <mesh castShadow position={[0, 1.32, 0]}>
        <coneGeometry args={[0.76, 1.65, 9]} />
        <meshStandardMaterial color="#2f7d52" />
      </mesh>
    </group>
  );
}

function LocalAvatar({ player, vrmUrl, onMove }) {
  const group = useRef();
  const controls = useRef();
  const keys = useKeyMap();
  const { camera } = useThree();
  const motion = useRef({ moving: false, speed: 0 });
  const velocity = useRef(new THREE.Vector3());
  const direction = useRef(new THREE.Vector3());
  const cameraForward = useRef(new THREE.Vector3());
  const cameraRight = useRef(new THREE.Vector3());
  const previousPosition = useRef(new THREE.Vector3());
  const movementDelta = useRef(new THREE.Vector3());
  const controlTarget = useRef(new THREE.Vector3());
  const jumpVelocity = useRef(0);
  const isJumping = useRef(false);
  const jumpTime = useRef(0);

  useFrame((state, delta) => {
    if (!group.current) return;

    const frameDelta = Math.min(delta, 1 / 30);
    previousPosition.current.copy(group.current.position);
    direction.current.set(0, 0, 0);
    cameraForward.current.subVectors(group.current.position, camera.position);
    cameraForward.current.y = 0;

    if (cameraForward.current.lengthSq() < 0.001) {
      cameraForward.current.set(0, 0, -1);
    } else {
      cameraForward.current.normalize();
    }

    cameraRight.current.crossVectors(cameraForward.current, WORLD_UP).normalize();

    if (keys.current.forward) direction.current.add(cameraForward.current);
    if (keys.current.backward) direction.current.sub(cameraForward.current);
    if (keys.current.left) direction.current.sub(cameraRight.current);
    if (keys.current.right) direction.current.add(cameraRight.current);

    const hasInput = direction.current.lengthSq() > 0;
    if (hasInput) {
      direction.current.normalize().multiplyScalar(MOVEMENT_SPEED);
    }

    velocity.current.lerp(direction.current, 1 - Math.exp(-frameDelta * (hasInput ? 18 : 14)));
    const speed = velocity.current.length();
    const moving = speed > 0.05;
    motion.current.moving = moving;
    motion.current.speed = speed / MOVEMENT_SPEED;

    // ジャンプ処理
    if (keys.current.jump && !isJumping.current && group.current.position.y < 0.05) {
      jumpVelocity.current = 8.5;
      isJumping.current = true;
      jumpTime.current = 0;
    }

    // ジャンプ物理演算
    if (isJumping.current) {
      jumpTime.current += frameDelta;
      jumpVelocity.current -= 20 * frameDelta;
      group.current.position.y += jumpVelocity.current * frameDelta;

      if (group.current.position.y <= 0) {
        group.current.position.y = 0;
        isJumping.current = false;
        jumpVelocity.current = 0;
      }
    }

    if (moving) {
      group.current.position.addScaledVector(velocity.current, frameDelta);

      if (group.current.position.x < -18 || group.current.position.x > 18) {
        group.current.position.x = THREE.MathUtils.clamp(group.current.position.x, -18, 18);
        velocity.current.x = 0;
      }
      if (group.current.position.z < -18 || group.current.position.z > 18) {
        group.current.position.z = THREE.MathUtils.clamp(group.current.position.z, -18, 18);
        velocity.current.z = 0;
      }

      const targetYaw = Math.atan2(velocity.current.x, velocity.current.z) + AVATAR_FORWARD_OFFSET;
      group.current.rotation.y = dampAngle(group.current.rotation.y, targetYaw, TURN_SPEED * 2.4, frameDelta);
    }

    movementDelta.current.subVectors(group.current.position, previousPosition.current);
    camera.position.add(movementDelta.current);
    if (controls.current) {
      controlTarget.current.set(group.current.position.x, 1.15, group.current.position.z);
      controls.current.target.lerp(controlTarget.current, 1 - Math.exp(-frameDelta * 14));
      controls.current.update();
    }

    const animation = moving ? "walk" : isJumping.current ? "jump" : "idle";
    onMove({
      position: {
        x: group.current.position.x,
        y: group.current.position.y,
        z: group.current.position.z,
      },
      rotationY: group.current.rotation.y,
      animation,
    });
  });

  return (
    <>
      <group
        ref={group}
        position={[player.position?.x || 0, player.position?.y || 0, player.position?.z || 0]}
        rotation-y={player.rotationY || 0}
      >
        <AvatarBody player={player} vrmUrl={vrmUrl} isLocal motionRef={motion} />
      </group>
      <OrbitControls
        ref={controls}
        enablePan={false}
        enableDamping
        maxPolarAngle={Math.PI / 2.08}
        minDistance={4.8}
        maxDistance={12}
        target={[player.position?.x || 0, 1.15, player.position?.z || 0]}
      />
    </>
  );
}

function RemoteAvatar({ player }) {
  const ref = useRef();
  const target = useMemo(
    () => ({
      position: new THREE.Vector3(player.position?.x || 0, 0, player.position?.z || 0),
      rotationY: player.rotationY || 0,
    }),
    [player.position?.x, player.position?.z, player.rotationY],
  );

  useFrame((_state, delta) => {
    if (!ref.current) return;
    ref.current.position.lerp(target.position, 1 - Math.exp(-delta * 9));
    ref.current.rotation.y = dampAngle(ref.current.rotation.y, target.rotationY, 8, delta);
  });

  return (
    <group ref={ref} position={[player.position?.x || 0, 0, player.position?.z || 0]} rotation-y={player.rotationY || 0}>
      <AvatarBody player={player} />
    </group>
  );
}

function AvatarBody({ player, vrmUrl, isLocal = false, motionRef }) {
  const resolvedVrmUrl = vrmUrl || player.avatarUrl;
  const moving = player.animation === "walk";
  const jumping = player.animation === "jump";

  return (
    <group>
      {resolvedVrmUrl ? (
        <VRMAvatar url={resolvedVrmUrl} moving={moving} jumping={jumping} motionRef={motionRef} />
      ) : (
        <FallbackAvatar color={player.color} moving={moving} jumping={jumping} motionRef={motionRef} />
      )}
      <Html center position={[0, 2.38, 0]} className="nameplate-wrapper">
        <div className={isLocal ? "nameplate local" : "nameplate"}>{player.name || "Guest"}</div>
      </Html>
    </group>
  );
}

function VRMAvatar({ url, moving, jumping, motionRef }) {
  const vrm = useVRM(url);
  const bob = useRef(0);
  const bones = useRef(null);

  React.useEffect(() => {
    bones.current = null;
  }, [vrm]);

  useFrame((_state, delta) => {
    if (!vrm?.scene) return;
    const isMoving = motionRef?.current?.moving ?? moving;
    const motionSpeed = motionRef?.current?.speed ?? (moving ? 1 : 0);
    const isJumping = motionRef?.current?.jumping ?? jumping;
    
    bob.current += delta * (isMoving ? THREE.MathUtils.lerp(7, 11, motionSpeed) : isJumping ? 0 : 2);
    
    if (isJumping) {
      vrm.scene.position.y = Math.sin(bob.current) * 0.12;
    } else {
      vrm.scene.position.y = Math.sin(bob.current) * (isMoving ? 0.035 * motionSpeed : 0.012);
    }
    
    animateVRMWalk(vrm, bob.current, isMoving && !isJumping, delta, bones, motionSpeed);
    vrm.update(delta);
  });

  if (!vrm?.scene) {
    return <FallbackAvatar color="#4f8cff" moving={moving} jumping={jumping} motionRef={motionRef} />;
  }

  return <primitive object={vrm.scene} scale={1.15} rotation-y={Math.PI} />;
}

function useVRM(url) {
  const [vrm, setVrm] = useState(null);

  React.useEffect(() => {
    if (!url) return;
    let disposed = false;
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    loader.load(
      url,
      (gltf) => {
        if (disposed) return;
        const loadedVrm = gltf.userData.vrm;
        VRMUtils.removeUnnecessaryVertices(gltf.scene);
        VRMUtils.removeUnnecessaryJoints(gltf.scene);
        loadedVrm.scene.traverse((object) => {
          object.frustumCulled = false;
          if (object.isMesh) object.castShadow = true;
        });
        setVrm(loadedVrm);
      },
      undefined,
      (error) => {
        console.error("VRM load failed", error);
      },
    );

    return () => {
      disposed = true;
    };
  }, [url]);

  if (!vrm) {
    return null;
  }

  return vrm;
}

function FallbackAvatar({ color, moving, jumping, motionRef }) {
  const group = useRef();
  const leftArm = useRef();
  const rightArm = useRef();
  const leftLeg = useRef();
  const rightLeg = useRef();

  useFrame(({ clock }) => {
    if (!group.current) return;
    const isMoving = motionRef?.current?.moving ?? moving;
    const isJumping = motionRef?.current?.jumping ?? jumping;
    const motionSpeed = motionRef?.current?.speed ?? (moving ? 1 : 0);
    const speed = isMoving ? THREE.MathUtils.lerp(7, 10, motionSpeed) : isJumping ? 0 : 2;
    const phase = clock.elapsedTime * speed;
    const stride = isMoving ? 0.55 * motionSpeed : 0.06;

    if (isJumping) {
      group.current.position.y = Math.sin(phase) * 0.2;
    } else {
      group.current.position.y = Math.abs(Math.sin(phase)) * (isMoving ? 0.075 * motionSpeed : 0.012);
    }
    
    group.current.rotation.z = Math.sin(phase) * (isMoving ? 0.035 * motionSpeed : 0.012);

    if (leftArm.current && rightArm.current && leftLeg.current && rightLeg.current) {
      if (isJumping) {
        leftArm.current.rotation.x = -0.4;
        rightArm.current.rotation.x = -0.4;
        leftLeg.current.rotation.x = 0.3;
        rightLeg.current.rotation.x = 0.3;
      } else {
        leftArm.current.rotation.x = Math.sin(phase) * stride;
        rightArm.current.rotation.x = Math.sin(phase + Math.PI) * stride;
        leftLeg.current.rotation.x = Math.sin(phase + Math.PI) * stride * 0.8;
        rightLeg.current.rotation.x = Math.sin(phase) * stride * 0.8;
      }
    }
  });

  return (
    <group ref={group}>
      <group ref={leftArm} position={[-0.43, 1.02, 0]}>
        <mesh castShadow position={[0, -0.29, 0]}>
          <capsuleGeometry args={[0.075, 0.42, 6, 10]} />
          <meshStandardMaterial color={color || "#7dd3fc"} roughness={0.58} />
        </mesh>
      </group>
      <group ref={rightArm} position={[0.43, 1.02, 0]}>
        <mesh castShadow position={[0, -0.29, 0]}>
          <capsuleGeometry args={[0.075, 0.42, 6, 10]} />
          <meshStandardMaterial color={color || "#7dd3fc"} roughness={0.58} />
        </mesh>
      </group>
      <mesh castShadow position={[0, 0.82, 0]}>
        <capsuleGeometry args={[0.34, 0.72, 8, 16]} />
        <meshStandardMaterial color={color || "#7dd3fc"} roughness={0.55} />
      </mesh>
      <mesh castShadow position={[0, 1.55, 0]}>
        <sphereGeometry args={[0.34, 24, 18]} />
        <meshStandardMaterial color="#f4c7a1" roughness={0.48} />
      </mesh>
      <mesh castShadow position={[0, 1.88, -0.02]}>
        <sphereGeometry args={[0.36, 24, 18, 0, Math.PI * 2, 0, Math.PI * 0.52]} />
        <meshStandardMaterial color="#243044" roughness={0.6} />
      </mesh>
      <mesh castShadow position={[0, 0.35, 0.22]} rotation-x={0.16}>
        <boxGeometry args={[0.72, 0.12, 0.24]} />
        <meshStandardMaterial color="#243044" />
      </mesh>
      <group ref={leftLeg} position={[-0.16, 0.43, 0]}>
        <mesh castShadow position={[0, -0.3, 0]}>
          <capsuleGeometry args={[0.09, 0.48, 6, 10]} />
          <meshStandardMaterial color="#263449" roughness={0.6} />
        </mesh>
      </group>
      <group ref={rightLeg} position={[0.16, 0.43, 0]}>
        <mesh castShadow position={[0, -0.3, 0]}>
          <capsuleGeometry args={[0.09, 0.48, 6, 10]} />
          <meshStandardMaterial color="#263449" roughness={0.6} />
        </mesh>
      </group>
    </group>
  );
}

function animateVRMWalk(vrm, phase, moving, delta, cacheRef, motionSpeed = 1) {
  if (!cacheRef.current) {
    const humanoid = vrm.humanoid;
    const getBone = (name) =>
      humanoid?.getNormalizedBoneNode?.(name) || humanoid?.getRawBoneNode?.(name) || null;

    cacheRef.current = {
      hips: getBone("hips"),
      spine: getBone("spine"),
      chest: getBone("chest"),
      leftUpperArm: getBone("leftUpperArm"),
      rightUpperArm: getBone("rightUpperArm"),
      leftLowerArm: getBone("leftLowerArm"),
      rightLowerArm: getBone("rightLowerArm"),
      leftUpperLeg: getBone("leftUpperLeg"),
      rightUpperLeg: getBone("rightUpperLeg"),
      leftLowerLeg: getBone("leftLowerLeg"),
      rightLowerLeg: getBone("rightLowerLeg"),
    };
  }

  const bones = cacheRef.current;
  const walk = moving ? THREE.MathUtils.clamp(motionSpeed, 0, 1) : 0;
  const armSwing = Math.sin(phase) * 0.34 * walk;
  const legSwing = Math.sin(phase) * 0.42 * walk;
  const kneeBend = Math.max(0, Math.sin(phase + Math.PI / 2)) * 0.18 * walk;
  const idleBreath = Math.sin(phase * 0.45) * 0.018;
  const bodySway = Math.sin(phase) * (moving ? 0.045 : 0.012);

  applyBoneRotation(bones.leftUpperArm, delta, -0.08 + armSwing, 0.08, -1.18);
  applyBoneRotation(bones.rightUpperArm, delta, -0.08 - armSwing, -0.08, 1.18);
  applyBoneRotation(bones.leftLowerArm, delta, -0.18 + armSwing * 0.25, 0, -0.22);
  applyBoneRotation(bones.rightLowerArm, delta, -0.18 - armSwing * 0.25, 0, 0.22);
  applyBoneRotation(bones.leftUpperLeg, delta, -legSwing, 0, 0.03);
  applyBoneRotation(bones.rightUpperLeg, delta, legSwing, 0, -0.03);
  applyBoneRotation(bones.leftLowerLeg, delta, kneeBend, 0, 0);
  applyBoneRotation(bones.rightLowerLeg, delta, Math.max(0, Math.sin(phase - Math.PI / 2)) * 0.18 * walk, 0, 0);
  applyBoneRotation(bones.spine, delta, idleBreath, 0, bodySway);
  applyBoneRotation(bones.chest, delta, idleBreath * 0.5, 0, bodySway * 0.5);
  applyBoneRotation(bones.hips, delta, 0, 0, -bodySway * 0.45);
}

function applyBoneRotation(bone, delta, x = 0, y = 0, z = 0) {
  if (!bone) return;
  const strength = 14;
  bone.rotation.x = THREE.MathUtils.damp(bone.rotation.x, x, strength, delta);
  bone.rotation.y = THREE.MathUtils.damp(bone.rotation.y, y, strength, delta);
  bone.rotation.z = THREE.MathUtils.damp(bone.rotation.z, z, strength, delta);
}

function TopBar({
  profile,
  connected,
  playerCount,
  onProfileChange,
  onVrmFile,
  worlds,
  currentWorldId,
  onWorldChange,
  onCreateWorld,
  onOpenEditor,
}) {
  const fileInput = useRef();
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");

  const handleFile = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadError("");
    try {
      await onVrmFile(file);
    } catch (error) {
      console.error(error);
      setUploadError("VRM upload failed");
    } finally {
      setUploading(false);
      event.target.value = "";
    }
  };

  return (
    <header className="topbar">
      <div className="brand">
        <Video size={22} />
        <span>Gen Verse</span>
      </div>
      <div className="topbar-controls">
        <label className="world-select">
          <Globe2 size={16} />
          <select value={currentWorldId} onChange={(event) => onWorldChange(event.target.value)}>
            {worlds.map((world) => (
              <option key={world.id} value={world.id}>
                {world.name}
              </option>
            ))}
          </select>
        </label>
        <button className="icon-button" type="button" onClick={onCreateWorld} title="Create world">
          <Plus size={18} />
        </button>
        <button className="icon-button" type="button" onClick={onOpenEditor} title="Edit verse.api script">
          <Code2 size={18} />
        </button>
        <label className="profile-field">
          <span>Name</span>
          <input
            value={profile.name}
            maxLength={28}
            onChange={(event) => onProfileChange({ ...profile, name: event.target.value || "Guest" })}
          />
        </label>
        <label className="color-dot" style={{ "--avatar-color": profile.color }}>
          <input
            aria-label="Avatar color"
            type="color"
            value={profile.color}
            onChange={(event) => onProfileChange({ ...profile, color: event.target.value })}
          />
        </label>
        <button className="icon-button wide" type="button" onClick={() => fileInput.current?.click()} disabled={uploading}>
          <Upload size={18} />
          <span>{uploading ? "Uploading" : "VRM"}</span>
        </button>
        <input ref={fileInput} className="hidden-input" type="file" accept=".vrm,model/gltf-binary" onChange={handleFile} />
        {uploadError ? <span className="upload-error">{uploadError}</span> : null}
        <div className="status-pill" data-online={connected}>
          <Users size={16} />
          <span>{playerCount}</span>
        </div>
      </div>
    </header>
  );
}

function WorldEditor({ world, onClose, onSave }) {
  const [draft, setDraft] = useState(world);
  const [saving, setSaving] = useState(false);

  React.useEffect(() => {
    setDraft(world);
  }, [world]);

  const save = async () => {
    setSaving(true);
    try {
      await onSave(draft);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="world-editor">
      <div className="editor-header">
        <div>
          <span>verse.api</span>
          <input
            value={draft.name}
            maxLength={48}
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
          />
        </div>
        <div className="editor-actions">
          <button className="icon-button" type="button" onClick={save} disabled={saving} title="Save world">
            <Save size={17} />
          </button>
          <button className="icon-button" type="button" onClick={onClose} title="Close editor">
            <X size={17} />
          </button>
        </div>
      </div>
      <textarea
        value={draft.script}
        spellCheck="false"
        onChange={(event) => setDraft((current) => ({ ...current, script: event.target.value }))}
      />
      <div className="editor-help">
        api.box, api.platform, api.wall, api.cylinder, api.sphere, api.tree, api.sign
      </div>
    </section>
  );
}

function ChatPanel({ profile, messages, onSend }) {
  const [text, setText] = useState("");
  const listRef = useRef();

  React.useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  const submit = (event) => {
    event.preventDefault();
    if (!text.trim()) return;
    onSend(text.trim());
    setText("");
  };

  return (
    <aside className="chat-panel">
      <div className="chat-title">
        <MessageCircle size={18} />
        <span>Chat</span>
      </div>
      <div className="chat-list" ref={listRef}>
        {messages.length === 0 ? (
          <p className="empty-chat">まだ会話はありません。</p>
        ) : (
          messages.map((message) => (
            <div key={message.id} className="chat-message">
              <span>{message.name || profile.name}</span>
              <p>{message.text}</p>
            </div>
          ))
        )}
      </div>
      <form className="chat-form" onSubmit={submit}>
        <input value={text} maxLength={180} onChange={(event) => setText(event.target.value)} placeholder="メッセージを入力" />
        <button type="submit" aria-label="Send message">
          <Send size={17} />
        </button>
      </form>
    </aside>
  );
}

function useKeyMap() {
  const keys = useRef({
    forward: false,
    backward: false,
    left: false,
    right: false,
    jump: false,
  });

  React.useEffect(() => {
    const setKey = (event, pressed) => {
      const target = event.target;
      const isTyping =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable;
      if (isTyping) return;

      const key = event.key.toLowerCase();
      if (["w", "arrowup"].includes(key)) keys.current.forward = pressed;
      if (["s", "arrowdown"].includes(key)) keys.current.backward = pressed;
      if (["a", "arrowleft"].includes(key)) keys.current.left = pressed;
      if (["d", "arrowright"].includes(key)) keys.current.right = pressed;
      if (key === " ") keys.current.jump = pressed;
    };

    const down = (event) => setKey(event, true);
    const up = (event) => setKey(event, false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  return keys;
}

function dampAngle(current, target, lambda, delta) {
  const wrapped = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + wrapped * (1 - Math.exp(-lambda * delta));
}

function randomColor() {
  const colors = ["#4f8cff", "#ef7d57", "#45b883", "#f2b705", "#9b6ef3", "#ef5d8f"];
  return colors[Math.floor(Math.random() * colors.length)];
}

createRoot(document.getElementById("root")).render(<App />);
