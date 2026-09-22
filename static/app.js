const state = {
    id: localStorage.getItem("growworld_id") || crypto.randomUUID(),
    name: "",
    height: 1,
    ws: null,
    scene: null,
    camera: null,
    renderer: null,
    localPlayer: null,
    remotePlayers: new Map(),
    keys: {},
    velocityY: 0,
    grounded: true,
    yaw: 0,
    pitch: 0.35,
    cameraDistance: 8,
    lastSent: 0,
    worldSize: 400
};

localStorage.setItem("growworld_id", state.id);

const login = document.getElementById("login");
const hud = document.getElementById("hud");
const nameInput = document.getElementById("nameInput");
const startButton = document.getElementById("startButton");
const loginStatus = document.getElementById("loginStatus");
const growButton = document.getElementById("growButton");
const heightEl = document.getElementById("height");
const onlineEl = document.getElementById("online");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const chatMessages = document.getElementById("chatMessages");
const mapCanvas = document.getElementById("mapCanvas");
const mapCtx = mapCanvas.getContext("2d");

nameInput.value = localStorage.getItem("growworld_name") || "";

function escapeHtml(text) {
    return String(text)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function addChatMessage(name, text, system = false) {
    const div = document.createElement("div");
    div.className = "message";
    div.innerHTML = system
        ? `<span style="color:#91a7bf">${escapeHtml(text)}</span>`
        : `<b>${escapeHtml(name)}</b>: ${escapeHtml(text)}`;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function setHeight(height) {
    state.height = Number(height);
    heightEl.textContent = `${state.height.toFixed(2)} м`;

    // The complete model grows vertically with the player's height.
    if (state.localPlayer) {
        state.localPlayer.scale.y = state.height;
        state.localPlayer.userData.height = state.height;
    }
}

function send(payload) {
    if (state.ws?.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify(payload));
    }
}

function connect() {
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    state.ws = new WebSocket(`${protocol}://${location.host}/ws`);

    state.ws.onopen = () => {
        send({ type: "join", id: state.id, name: state.name });
        loginStatus.textContent = "";
    };

    state.ws.onmessage = event => {
        const data = JSON.parse(event.data);

        if (data.type === "welcome") {
            setHeight(data.player.height);
            createLocalPlayer(data.player);
            data.players.forEach(addRemotePlayer);

            login.classList.add("hidden");
            hud.classList.remove("hidden");
            addChatMessage("Система", "Добро пожаловать в GrowWorld!", true);
            updateOnline();
        }

        if (data.type === "player_joined") {
            addRemotePlayer(data.player);
            addChatMessage("Система", `${data.player.name} вошёл в мир`, true);
            updateOnline();
        }

        if (data.type === "player_left") {
            removeRemotePlayer(data.playerId);
            updateOnline();
        }

        if (data.type === "player_moved") updateRemotePlayer(data.player);
        if (data.type === "height_updated") setHeight(data.height);
        if (data.type === "player_grew") updateRemotePlayer(data.player);
        if (data.type === "chat") addChatMessage(data.name, data.text);
    };

    state.ws.onerror = () => {
        loginStatus.textContent = "Не удалось подключиться к серверу.";
    };
}

function makePlayer(color, height = 1) {
    const group = new THREE.Group();

    // Base model represents approximately 1 meter.
    const body = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.38, 1.05, 6, 12),
        new THREE.MeshStandardMaterial({ color })
    );
    body.position.y = 0.9;
    body.castShadow = true;
    group.add(body);

    const head = new THREE.Mesh(
        new THREE.SphereGeometry(0.38, 16, 12),
        new THREE.MeshStandardMaterial({ color: 0xffd0ae })
    );
    head.position.y = 1.72;
    head.castShadow = true;
    group.add(head);

    group.scale.y = height;
    group.userData.height = height;
    return group;
}

function createLocalPlayer(p) {
    state.localPlayer = makePlayer(0x2388ff, p.height);
    state.localPlayer.position.set(p.position.x, p.position.y, p.position.z);
    state.localPlayer.rotation.y = p.rotation || 0;
    state.scene.add(state.localPlayer);
    state.yaw = p.rotation || 0;
}

function addRemotePlayer(p) {
    if (state.remotePlayers.has(p.id)) return;

    const mesh = makePlayer(0xff5577, p.height);
    mesh.position.set(p.position.x, p.position.y, p.position.z);
    mesh.rotation.y = p.rotation || 0;
    mesh.userData.name = p.name;
    mesh.userData.targetPosition = mesh.position.clone();
    mesh.userData.targetRotation = mesh.rotation.y;

    state.scene.add(mesh);
    state.remotePlayers.set(p.id, mesh);
}

function updateRemotePlayer(p) {
    let mesh = state.remotePlayers.get(p.id);
    if (!mesh) {
        addRemotePlayer(p);
        mesh = state.remotePlayers.get(p.id);
    }

    mesh.userData.targetPosition.set(p.position.x, p.position.y, p.position.z);
    mesh.userData.targetRotation = p.rotation || 0;

    // Other players grow too.
    mesh.scale.y = p.height;
    mesh.userData.height = p.height;
}

function removeRemotePlayer(id) {
    const mesh = state.remotePlayers.get(id);
    if (!mesh) return;
    state.scene.remove(mesh);
    state.remotePlayers.delete(id);
}

function updateOnline() {
    onlineEl.textContent = `Онлайн: ${state.remotePlayers.size + 1}`;
}

function createWorld() {
    state.scene = new THREE.Scene();
    state.scene.background = new THREE.Color(0x8fc8ff);
    state.scene.fog = new THREE.Fog(0x8fc8ff, 90, 420);

    state.camera = new THREE.PerspectiveCamera(
        65,
        innerWidth / innerHeight,
        0.1,
        1000
    );

    state.renderer = new THREE.WebGLRenderer({ antialias: true });
    state.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    state.renderer.setSize(innerWidth, innerHeight);
    state.renderer.shadowMap.enabled = true;
    document.getElementById("game").appendChild(state.renderer.domElement);

    state.scene.add(new THREE.HemisphereLight(0xffffff, 0x4b6a48, 2.1));

    const sun = new THREE.DirectionalLight(0xffffff, 2.5);
    sun.position.set(80, 120, 60);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    state.scene.add(sun);

    const ground = new THREE.Mesh(
        new THREE.PlaneGeometry(400, 400),
        new THREE.MeshStandardMaterial({ color: 0x5da653 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    state.scene.add(ground);

    createRoads();
    createBuildings();
    createTrees();

    state.renderer.domElement.addEventListener("mousedown", () => {
        state.renderer.domElement.requestPointerLock?.();
    });

    document.addEventListener("mousemove", event => {
        if (document.pointerLockElement !== state.renderer.domElement) return;
        state.yaw -= event.movementX * 0.0025;
        state.pitch -= event.movementY * 0.002;
        state.pitch = Math.max(-0.2, Math.min(1.15, state.pitch));
    });

    state.renderer.domElement.addEventListener("wheel", event => {
        state.cameraDistance += event.deltaY * 0.01;
        state.cameraDistance = Math.max(3, Math.min(18, state.cameraDistance));
    }, { passive: true });

    animate();
}

function createRoads() {
    const roadMat = new THREE.MeshStandardMaterial({ color: 0x3b424a });
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xf5dc63 });

    for (const rot of [0, Math.PI / 2]) {
        const road = new THREE.Mesh(
            new THREE.PlaneGeometry(400, 12),
            roadMat
        );
        road.rotation.x = -Math.PI / 2;
        road.rotation.z = rot;
        road.position.y = 0.012;
        state.scene.add(road);

        const line = new THREE.Mesh(
            new THREE.PlaneGeometry(400, 0.18),
            lineMat
        );
        line.rotation.x = -Math.PI / 2;
        line.rotation.z = rot;
        line.position.y = 0.02;
        state.scene.add(line);
    }
}

function createBuildings() {
    const colors = [0xd9e5ef, 0xf0d6b6, 0xcbd9c7, 0xe5c7d9, 0xd4d0ee];

    for (let x = -150; x <= 150; x += 35) {
        for (let z = -150; z <= 150; z += 35) {
            if (Math.abs(x) < 25 || Math.abs(z) < 25) continue;

            const w = 14 + Math.random() * 8;
            const h = 5 + Math.random() * 10;
            const d = 14 + Math.random() * 8;

            const building = new THREE.Mesh(
                new THREE.BoxGeometry(w, h, d),
                new THREE.MeshStandardMaterial({
                    color: colors[Math.floor(Math.random() * colors.length)]
                })
            );

            building.position.set(
                x + Math.random() * 8 - 4,
                h / 2,
                z + Math.random() * 8 - 4
            );
            building.castShadow = true;
            building.receiveShadow = true;
            state.scene.add(building);

            const roof = new THREE.Mesh(
                new THREE.ConeGeometry(Math.max(w, d) * 0.72, 4, 4),
                new THREE.MeshStandardMaterial({ color: 0x8a5d4b })
            );
            roof.position.set(building.position.x, h + 2, building.position.z);
            roof.rotation.y = Math.PI / 4;
            roof.castShadow = true;
            state.scene.add(roof);
        }
    }
}

function createTrees() {
    for (let i = 0; i < 170; i++) {
        const x = Math.random() * 370 - 185;
        const z = Math.random() * 370 - 185;

        if (Math.abs(x) < 15 || Math.abs(z) < 15) continue;

        const tree = new THREE.Group();

        const trunk = new THREE.Mesh(
            new THREE.CylinderGeometry(0.18, 0.25, 2, 8),
            new THREE.MeshStandardMaterial({ color: 0x76513b })
        );
        trunk.position.y = 1;
        trunk.castShadow = true;
        tree.add(trunk);

        const leaves = new THREE.Mesh(
            new THREE.SphereGeometry(1.5, 10, 8),
            new THREE.MeshStandardMaterial({ color: 0x2f873f })
        );
        leaves.position.y = 2.8;
        leaves.castShadow = true;
        tree.add(leaves);

        tree.position.set(x, 0, z);
        state.scene.add(tree);
    }
}

function updatePlayer(dt) {
    if (!state.localPlayer) return;

    const player = state.localPlayer;

    // Защита от неправильных координат
    if (
        !Number.isFinite(player.position.x) ||
        !Number.isFinite(player.position.y) ||
        !Number.isFinite(player.position.z)
    ) {
        player.position.set(0, 0, 0);
        state.velocityY = 0;
        state.grounded = true;
    }

    // Клавиши
    const w = !!state.keys["KeyW"];
    const s = !!state.keys["KeyS"];
    const a = !!state.keys["KeyA"];
    const d = !!state.keys["KeyD"];

    let moveX = 0;
    let moveZ = 0;

    // Направление камеры
    const forwardX = Math.sin(state.yaw);
    const forwardZ = Math.cos(state.yaw);

    // Правое направление камеры
    const rightX = Math.cos(state.yaw);
    const rightZ = -Math.sin(state.yaw);

    // W / S
    if (w) {
        moveX += forwardX;
        moveZ += forwardZ;
    }

    if (s) {
        moveX -= forwardX;
        moveZ -= forwardZ;
    }

    // A / D
    if (a) {
        moveX -= rightX;
        moveZ -= rightZ;
    }

    if (d) {
        moveX += rightX;
        moveZ += rightZ;
    }

    // Нормализация диагонального движения
    const length = Math.hypot(moveX, moveZ);

    if (length > 0) {
        moveX /= length;
        moveZ /= length;

        const speed = 7;

        player.position.x += moveX * speed * dt;
        player.position.z += moveZ * speed * dt;

        // Поворачиваем модель в сторону движения
        player.rotation.y = Math.atan2(moveX, moveZ);
    }

    // =========================
    // Прыжок / гравитация
    // =========================

    state.velocityY -= 18 * dt;

    player.position.y += state.velocityY * dt;

    if (player.position.y <= 0) {
        player.position.y = 0;
        state.velocityY = 0;
        state.grounded = true;
    }

    // =========================
    // Жёсткие границы мира
    // =========================

    const LIMIT = 190;

    player.position.x = THREE.MathUtils.clamp(
        player.position.x,
        -LIMIT,
        LIMIT
    );

    player.position.z = THREE.MathUtils.clamp(
        player.position.z,
        -LIMIT,
        LIMIT
    );

    // Y тоже защищаем
    if (!Number.isFinite(player.position.y)) {
        player.position.y = 0;
        state.velocityY = 0;
    }

    player.position.y = Math.max(
        0,
        Math.min(100, player.position.y)
    );

    // =========================
    // Отправка серверу
    // =========================

    const now = performance.now();

    if (
        now - state.lastSent > 50 &&
        state.ws &&
        state.ws.readyState === WebSocket.OPEN
    ) {
        send({
            type: "move",

            position: {
                x: Number(player.position.x),
                y: Number(player.position.y),
                z: Number(player.position.z)
            },

            rotation: Number(player.rotation.y)
        });

        state.lastSent = now;
    }
}

function updateCamera() {
    if (!state.localPlayer) return;

    const target = state.localPlayer.position.clone();
    target.y += Math.max(1.2, state.height * 1.25);

    const horizontal = Math.cos(state.pitch) * state.cameraDistance;
    const vertical = Math.sin(state.pitch) * state.cameraDistance;

    const camX = target.x - Math.sin(state.yaw) * horizontal;
    const camZ = target.z - Math.cos(state.yaw) * horizontal;
    const camY = target.y + vertical;

    state.camera.position.lerp(
        new THREE.Vector3(camX, camY, camZ),
        0.12
    );
    state.camera.lookAt(target);
}

function updateRemotePlayers() {
    for (const mesh of state.remotePlayers.values()) {
        if (mesh.userData.targetPosition) {
            mesh.position.lerp(mesh.userData.targetPosition, 0.18);
            mesh.rotation.y +=
                (mesh.userData.targetRotation - mesh.rotation.y) * 0.18;
        }
    }
}

function drawMinimap() {
    const w = mapCanvas.width;
    const h = mapCanvas.height;

    mapCtx.clearRect(0, 0, w, h);
    mapCtx.fillStyle = "#1d5530";
    mapCtx.fillRect(0, 0, w, h);

    mapCtx.fillStyle = "#3d4148";
    mapCtx.fillRect(0, h / 2 - 7, w, 14);
    mapCtx.fillRect(w / 2 - 7, 0, 14, h);

    const scale = w / state.worldSize;
    const toMap = (x, z) => ({
        x: w / 2 + x * scale,
        y: h / 2 + z * scale
    });

    for (const mesh of state.remotePlayers.values()) {
        const p = toMap(mesh.position.x, mesh.position.z);
        mapCtx.fillStyle = "#ff5577";
        mapCtx.beginPath();
        mapCtx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        mapCtx.fill();
    }

    if (state.localPlayer) {
        const p = toMap(
            state.localPlayer.position.x,
            state.localPlayer.position.z
        );
        mapCtx.fillStyle = "#42a5ff";
        mapCtx.beginPath();
        mapCtx.arc(p.x, p.y, 5, 0, Math.PI * 2);
        mapCtx.fill();
    }
}

let lastTime = performance.now();

function animate() {
    requestAnimationFrame(animate);

    const now = performance.now();
    const dt = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;

    updatePlayer(dt);
    updateRemotePlayers();
    updateCamera();
    drawMinimap();

    state.renderer.render(state.scene, state.camera);
}

startButton.addEventListener("click", () => {
    const name = nameInput.value.trim() || "Player";
    state.name = name;
    localStorage.setItem("growworld_name", name);
    loginStatus.textContent = "Подключение...";
    connect();
});

nameInput.addEventListener("keydown", e => {
    if (e.key === "Enter") startButton.click();
});

growButton.addEventListener("click", () => {
    send({ type: "grow" });
});

chatForm.addEventListener("submit", e => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;

    send({ type: "chat", text });
    chatInput.value = "";
});

window.addEventListener("keydown", e => {
    // Не перехватываем клавиатуру, когда пользователь пишет в чат
    if (
        e.target &&
        (
            e.target.tagName === "INPUT" ||
            e.target.tagName === "TEXTAREA"
        )
    ) {
        return;
    }

    if (
        e.code === "KeyW" ||
        e.code === "KeyA" ||
        e.code === "KeyS" ||
        e.code === "KeyD"
    ) {
        e.preventDefault();
        state.keys[e.code] = true;
    }

    if (e.code === "Space") {
        e.preventDefault();

        if (state.grounded) {
            state.velocityY = 7;
            state.grounded = false;
        }
    }
});

window.addEventListener("keyup", e => {
    if (
        e.code === "KeyW" ||
        e.code === "KeyA" ||
        e.code === "KeyS" ||
        e.code === "KeyD"
    ) {
        e.preventDefault();
        state.keys[e.code] = false;
    }
});

window.addEventListener("resize", () => {
    if (!state.camera || !state.renderer) return;

    state.camera.aspect = innerWidth / innerHeight;
    state.camera.updateProjectionMatrix();
    state.renderer.setSize(innerWidth, innerHeight);
});

createWorld();
