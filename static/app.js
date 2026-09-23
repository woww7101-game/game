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

    worldSize: 400,

    // Загруженная модель персонажа
    playerModelTemplate: null,
    playerModelPromise: null,

    robloxUserId: null,
    robloxModelCache: new Map()
};

localStorage.setItem("growworld_id", state.id);


// ============================================================
// DOM
// ============================================================

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

nameInput.value =
    localStorage.getItem("growworld_name") || "";

// ============================================================
// UTILS
// ============================================================

function escapeHtml(text) {
    return String(text)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}


function addChatMessage(
    name,
    text,
    system = false
) {
    const div = document.createElement("div");

    div.className = "message";

    div.innerHTML = system
        ? `<span style="color:#91a7bf">${escapeHtml(text)}</span>`
        : `<b>${escapeHtml(name)}</b>: ${escapeHtml(text)}`;

    chatMessages.appendChild(div);

    chatMessages.scrollTop =
        chatMessages.scrollHeight;
}


function send(payload) {
    if (
        state.ws &&
        state.ws.readyState === WebSocket.OPEN
    ) {
        state.ws.send(
            JSON.stringify(payload)
        );
    }
}


// ============================================================
// PLAYER MODEL
// ============================================================

/*
    ВАЖНО:

    player.glb должен находиться здесь:

    /static/models/player.glb
*/
// =========================
// Roblox Avatar
// =========================

async function getRobloxAvatarData(userId) {

    const response = await fetch(
        `/roblox/avatar-data/${encodeURIComponent(userId)}`
    );

    if (!response.ok) {

        let message = "Не удалось получить Roblox Avatar.";

        try {
            const error = await response.json();

            if (error.detail) {
                message =
                    typeof error.detail === "string"
                        ? error.detail
                        : JSON.stringify(error.detail);
            }

        } catch (_) {}

        throw new Error(message);
    }

    const data = await response.json();

    if (!data.success) {

        throw new Error(
            `Roblox avatar state: ${data.state || "Unknown"}`
        );
    }

    return data;
}


function normalizeRobloxModel(model) {

    const box = new THREE.Box3().setFromObject(model);

    const size = new THREE.Vector3();

    box.getSize(size);

    if (
        !Number.isFinite(size.y) ||
        size.y <= 0
    ) {

        throw new Error(
            "Не удалось определить высоту Roblox-модели."
        );
    }

    // Roblox avatar = 1.0 игровый метр
    const scale = 1 / size.y;

    model.scale.setScalar(scale);

    const normalizedBox =
        new THREE.Box3().setFromObject(model);

    // Ставим ноги на землю
    model.position.y -= normalizedBox.min.y;

    const center = new THREE.Vector3();

    normalizedBox.getCenter(center);

    model.position.x -= center.x;
    model.position.z -= center.z;

    return model;
}


async function loadRobloxPlayerModel(userId) {

    userId = Number(userId);

    if (
        !Number.isInteger(userId) ||
        userId <= 0
    ) {

        throw new Error(
            "Некорректный Roblox User ID."
        );
    }

    // Используем уже загруженную модель
    if (
        state.robloxModelCache.has(userId)
    ) {

        return state.robloxModelCache.get(
            userId
        ).clone(true);
    }

    console.log(
        "GrowWorld: загружаем Roblox avatar:",
        userId
    );

    const data =
        await getRobloxAvatarData(userId);

    console.log(
        "GrowWorld Roblox manifest:",
        data
    );

    const mtlLoader = new MTLLoader();

    const objLoader = new OBJLoader();

    // MTL находится на нашем сервере.
    const mtlUrl =
        `/roblox/asset/${encodeURIComponent(data.mtl)}`;

    // Очень важно:
    // ресурсные пути из MTL будут разрешаться
    // относительно этого URL.
    mtlLoader.setResourcePath(
        `/roblox/asset/`
    );

    const materials =
        await new Promise(
            (resolve, reject) => {

                mtlLoader.load(
                    mtlUrl,

                    resolve,

                    undefined,

                    reject
                );
            }
        );

    materials.preload();

    objLoader.setMaterials(
        materials
    );

    const objUrl =
        `/roblox/asset/${encodeURIComponent(data.obj)}`;

    const model =
        await new Promise(
            (resolve, reject) => {

                objLoader.load(
                    objUrl,

                    resolve,

                    undefined,

                    reject
                );
            }
        );

    model.traverse(object => {

        if (!object.isMesh) {
            return;
        }

        object.castShadow = true;
        object.receiveShadow = true;

        if (object.material) {

            if (Array.isArray(object.material)) {

                object.material =
                    object.material.map(
                        material =>
                            material.clone()
                    );

            } else {

                object.material =
                    object.material.clone();
            }
        }
    });

    normalizeRobloxModel(
        model
    );

    state.robloxModelCache.set(
        userId,
        model
    );

    console.log(
        "GrowWorld: Roblox avatar загружен!"
    );

    return model.clone(true);
}

function loadPlayerModel() {

    if (state.playerModelPromise) {
        return state.playerModelPromise;
    }

    state.playerModelPromise =
        new Promise((resolve, reject) => {

            if (
                typeof GLTFLoader ===
                "undefined"
            ) {
                reject(
                    new Error(
                        "GLTFLoader не найден. Проверь index.html."
                    )
                );

                return;
            }

            const loader =
                new GLTFLoader();

            loader.load(
                "/static/models/player.glb",

                gltf => {

                    const model =
                        gltf.scene;

                    /*
                        Убираем ненужные проблемы
                        с материалами и тенями.
                    */

                    model.traverse(
                        object => {

                            if (
                                object.isMesh
                            ) {

                                object.castShadow =
                                    true;

                                object.receiveShadow =
                                    true;

                                if (
                                    object.material
                                ) {

                                    object.material =
                                        object.material.clone();
                                }
                            }
                        }
                    );


                    /*
                        Определяем реальную
                        высоту модели.
                    */

                    const box =
                        new THREE.Box3()
                            .setFromObject(
                                model
                            );

                    const size =
                        new THREE.Vector3();

                    box.getSize(size);


                    if (
                        !Number.isFinite(
                            size.y
                        ) ||
                        size.y <= 0
                    ) {

                        reject(
                            new Error(
                                "Не удалось определить высоту player.glb"
                            )
                        );

                        return;
                    }


                    /*
                        Нормализуем модель:

                        исходная высота
                        становится 1 метр.
                    */

                    const normalize =
                        1 / size.y;

                    model.scale.setScalar(
                        normalize
                    );


                    /*
                        После масштабирования
                        снова определяем bounding box.
                    */

                    const normalizedBox =
                        new THREE.Box3()
                            .setFromObject(
                                model
                            );


                    /*
                        Ставим ноги ровно
                        на уровень Y = 0.
                    */

                    model.position.y -=
                        normalizedBox.min.y;


                    /*
                        Немного центрируем
                        модель по X/Z.
                    */

                    const center =
                        new THREE.Vector3();

                    normalizedBox.getCenter(
                        center
                    );

                    model.position.x -=
                        center.x;

                    model.position.z -=
                        center.z;


                    state.playerModelTemplate =
                        model;


                    console.log(
                        "GrowWorld: player.glb загружен"
                    );

                    resolve(model);
                },

                undefined,

                error => {

                    console.error(
                        "Ошибка загрузки player.glb:",
                        error
                    );

                    reject(error);
                }
            );
        });

    return state.playerModelPromise;
}


/*
    Создаёт копию модели.

    Каждому игроку нужна собственная
    копия, чтобы масштаб одного
    игрока не менял другого.
*/

function clonePlayerModel() {

    if (
        !state.playerModelTemplate
    ) {
        return null;
    }

    const clone =
        state.playerModelTemplate.clone(
            true
        );

    clone.traverse(
        object => {

            if (object.isMesh) {

                object.castShadow =
                    true;

                object.receiveShadow =
                    true;
            }
        }
    );

    return clone;
}


/*
    Применяем рост.

    Модель изначально нормализована
    до 1 метра.

    Поэтому:

    1.00 → scale 1
    1.50 → scale 1.5
    2.00 → scale 2
*/

function applyPlayerHeight(
    player,
    height
) {

    if (!player) return;

    const safeHeight =
        Math.max(
            0.01,
            Number(height) || 1
        );

    player.scale.setScalar(
        safeHeight
    );

    player.userData.height =
        safeHeight;
}


// ============================================================
// HEIGHT
// ============================================================

function setHeight(height) {

    state.height =
        Math.max(
            0.01,
            Number(height) || 1
        );

    heightEl.textContent =
        `${state.height.toFixed(2)} м`;

    if (state.localPlayer) {

        applyPlayerHeight(
            state.localPlayer,
            state.height
        );
    }
}


// ============================================================
// CONNECT
// ============================================================

function connect() {

    const protocol =
        location.protocol === "https:"
            ? "wss"
            : "ws";


    state.ws =
        new WebSocket(
            `${protocol}://${location.host}/ws`
        );


    // =========================
    // WebSocket connected
    // =========================

    state.ws.onopen = () => {

        const robloxUserId =
            Number(
                localStorage.getItem(
                    "growworld_roblox_id"
                )
            ) || null;


        send({

            type: "join",

            id: state.id,

            name: state.name,

            robloxUserId:
                robloxUserId

        });


        console.log(
            "GrowWorld: подключение установлено"
        );

        console.log(
            "Roblox User ID:",
            robloxUserId
        );


        loginStatus.textContent = "";
    };


    // =========================
    // WebSocket messages
    // =========================

    state.ws.onmessage = event => {

        const data =
            JSON.parse(event.data);


        // =========================
        // WELCOME
        // =========================

        if (data.type === "welcome") {

            setHeight(
                data.player.height
            );


            createLocalPlayer(
                data.player
            );


            data.players.forEach(
                addRemotePlayer
            );


            login.classList.add(
                "hidden"
            );


            hud.classList.remove(
                "hidden"
            );


            addChatMessage(
                "Система",
                "Добро пожаловать в GrowWorld!",
                true
            );


            updateOnline();
        }


        // =========================
        // PLAYER JOINED
        // =========================

        if (
            data.type ===
            "player_joined"
        ) {

            addRemotePlayer(
                data.player
            );


            addChatMessage(
                "Система",
                `${data.player.name} вошёл в мир`,
                true
            );


            updateOnline();
        }


        // =========================
        // PLAYER LEFT
        // =========================

        if (
            data.type ===
            "player_left"
        ) {

            removeRemotePlayer(
                data.playerId
            );


            updateOnline();
        }


        // =========================
        // PLAYER MOVED
        // =========================

        if (
            data.type ===
            "player_moved"
        ) {

            updateRemotePlayer(
                data.player
            );
        }


        // =========================
        // HEIGHT UPDATED
        // =========================

        if (
            data.type ===
            "height_updated"
        ) {

            setHeight(
                data.height
            );
        }


        // =========================
        // PLAYER GREW
        // =========================

        if (
            data.type ===
            "player_grew"
        ) {

            updateRemotePlayer(
                data.player
            );
        }


        // =========================
        // CHAT
        // =========================

        if (
            data.type ===
            "chat"
        ) {

            addChatMessage(
                data.name,
                data.text
            );
        }

    };


    // =========================
    // WebSocket error
    // =========================

    state.ws.onerror = () => {

        loginStatus.textContent =
            "Не удалось подключиться к серверу.";


        console.error(
            "GrowWorld: WebSocket error"
        );

    };


    // =========================
    // WebSocket closed
    // =========================

    state.ws.onclose = () => {

        console.log(
            "GrowWorld: WebSocket закрыт"
        );

    };

}

// ============================================================
// CREATE LOCAL PLAYER
// ============================================================

async function createLocalPlayer(p) {

    const group = new THREE.Group();

    group.position.set(
        Number(p.position.x) || 0,
        Number(p.position.y) || 0,
        Number(p.position.z) || 0
    );

    group.rotation.y =
        Number(p.rotation) || 0;

    group.userData.height =
        Number(p.height) || 1;

    state.localPlayer = group;

    state.scene.add(group);

    state.yaw =
        Number(p.rotation) || 0;

    // ---------------------------------
    // Roblox User ID
    // ---------------------------------

    const robloxId =
        Number(
            localStorage.getItem(
                "growworld_roblox_id"
            )
        );

    if (
        Number.isInteger(robloxId) &&
        robloxId > 0
    ) {

        try {

            const model =
                await loadRobloxPlayerModel(
                    robloxId
                );

            if (!state.localPlayer) {
                return;
            }

            state.localPlayer.userData.model =
                model;

            group.add(model);

            applyPlayerHeight(
                group,
                state.height
            );

            console.log(
                "GrowWorld: твой Roblox avatar установлен."
            );

            return;

        } catch (error) {

            console.error(
                "GrowWorld Roblox avatar error:",
                error
            );

            addChatMessage(
                "Система",
                "Не удалось загрузить Roblox-аватар. Используется запасная модель.",
                true
            );
        }
    }

    // ---------------------------------
    // Fallback: player.glb
    // ---------------------------------

    try {

        await loadPlayerModel();

        if (!state.localPlayer) {
            return;
        }

        const model =
            clonePlayerModel();

        if (!model) {
            return;
        }

        state.localPlayer.userData.model =
            model;

        group.add(model);

        applyPlayerHeight(
            group,
            state.height
        );

    } catch (error) {

        console.error(
            "Ошибка загрузки запасной модели:",
            error
        );
    }
}

// ============================================================
// REMOTE PLAYER
// ============================================================

async function addRemotePlayer(p) {

    if (
        state.remotePlayers.has(p.id)
    ) {
        return;
    }

    const group =
        new THREE.Group();

    group.position.set(
        Number(p.position.x) || 0,
        Number(p.position.y) || 0,
        Number(p.position.z) || 0
    );

    group.rotation.y =
        Number(p.rotation) || 0;

    group.userData.name =
        p.name || "Player";

    group.userData.height =
        Number(p.height) || 1;

    group.userData.targetPosition =
        group.position.clone();

    group.userData.targetRotation =
        group.rotation.y;

    state.scene.add(group);

    state.remotePlayers.set(
        p.id,
        group
    );

    // -----------------------------
    // Roblox avatar
    // -----------------------------

    const robloxId =
        Number(p.robloxUserId);

    if (
        Number.isInteger(robloxId) &&
        robloxId > 0
    ) {

        try {

            const model =
                await loadRobloxPlayerModel(
                    robloxId
                );

            if (
                !state.remotePlayers.has(
                    p.id
                )
            ) {
                return;
            }

            group.userData.model =
                model;

            group.add(model);

            applyPlayerHeight(
                group,
                p.height
            );

            return;

        } catch (error) {

            console.error(
                "Ошибка Roblox-модели игрока:",
                error
            );
        }
    }

    // -----------------------------
    // Fallback player.glb
    // -----------------------------

    try {

        await loadPlayerModel();

        const model =
            clonePlayerModel();

        if (!model) {
            return;
        }

        group.userData.model =
            model;

        group.add(model);

        applyPlayerHeight(
            group,
            p.height
        );

    } catch (error) {

        console.error(
            "Ошибка fallback-модели:",
            error
        );
    }
}

function updateRemotePlayer(p) {

    let mesh =
        state.remotePlayers.get(
            p.id
        );


    if (!mesh) {

        addRemotePlayer(p);

        mesh =
            state.remotePlayers.get(
                p.id
            );
    }


    if (!mesh) return;


    const x =
        Number(p.position.x);

    const y =
        Number(p.position.y);

    const z =
        Number(p.position.z);


    /*
        Защита от NaN.
    */

    if (
        Number.isFinite(x) &&
        Number.isFinite(y) &&
        Number.isFinite(z)
    ) {

        mesh.userData.targetPosition.set(
            x,
            y,
            z
        );
    }


    mesh.userData.targetRotation =
        Number(p.rotation) || 0;


    applyPlayerHeight(
        mesh,
        p.height
    );
}


function removeRemotePlayer(id) {

    const mesh =
        state.remotePlayers.get(id);

    if (!mesh) return;


    state.scene.remove(mesh);

    state.remotePlayers.delete(id);
}


function updateOnline() {

    onlineEl.textContent =
        `Онлайн: ${
            state.remotePlayers.size + 1
        }`;
}


// ============================================================
// WORLD
// ============================================================

function createWorld() {

    state.scene =
        new THREE.Scene();


    state.scene.background =
        new THREE.Color(
            0x8fc8ff
        );


    state.scene.fog =
        new THREE.Fog(
            0x8fc8ff,
            90,
            420
        );


    state.camera =
        new THREE.PerspectiveCamera(
            65,
            innerWidth / innerHeight,
            0.1,
            1000
        );


    state.renderer =
        new THREE.WebGLRenderer({
            antialias: true
        });


    state.renderer.setPixelRatio(
        Math.min(
            devicePixelRatio,
            2
        )
    );


    state.renderer.setSize(
        innerWidth,
        innerHeight
    );


    state.renderer.shadowMap.enabled =
        true;


    document
        .getElementById("game")
        .appendChild(
            state.renderer.domElement
        );


    state.scene.add(
        new THREE.HemisphereLight(
            0xffffff,
            0x4b6a48,
            2.1
        )
    );


    const sun =
        new THREE.DirectionalLight(
            0xffffff,
            2.5
        );


    sun.position.set(
        80,
        120,
        60
    );


    sun.castShadow = true;

    sun.shadow.mapSize.set(
        2048,
        2048
    );


    state.scene.add(sun);


    const ground =
        new THREE.Mesh(
            new THREE.PlaneGeometry(
                400,
                400
            ),
            new THREE.MeshStandardMaterial({
                color: 0x5da653
            })
        );


    ground.rotation.x =
        -Math.PI / 2;


    ground.receiveShadow = true;


    state.scene.add(ground);


    createRoads();
    createBuildings();
    createTrees();


    state.renderer.domElement
        .addEventListener(
            "mousedown",
            () => {

                state.renderer
                    .domElement
                    .requestPointerLock?.();
            }
        );


    document.addEventListener(
        "mousemove",
        event => {

            if (
                document.pointerLockElement !==
                state.renderer.domElement
            ) {
                return;
            }


            state.yaw -=
                event.movementX *
                0.0025;


            state.pitch -=
                event.movementY *
                0.002;


            state.pitch =
                Math.max(
                    -0.2,
                    Math.min(
                        1.15,
                        state.pitch
                    )
                );
        }
    );


    state.renderer.domElement
        .addEventListener(
            "wheel",
            event => {

                state.cameraDistance +=
                    event.deltaY * 0.01;


                state.cameraDistance =
                    Math.max(
                        3,
                        Math.min(
                            18,
                            state.cameraDistance
                        )
                    );
            },
            {
                passive: true
            }
        );


    animate();
}


// ============================================================
// ROADS
// ============================================================

function createRoads() {

    const roadMat =
        new THREE.MeshStandardMaterial({
            color: 0x3b424a
        });

    const lineMat =
        new THREE.MeshBasicMaterial({
            color: 0xf5dc63
        });

    for (
        const rot of [
            0,
            Math.PI / 2
        ]
    ) {

        const road =
            new THREE.Mesh(
                new THREE.PlaneGeometry(
                    400,
                    12
                ),
                roadMat
            );

        road.rotation.x =
            -Math.PI / 2;

        road.rotation.z =
            rot;

        road.position.y =
            0.012;

        state.scene.add(road);


        const line =
            new THREE.Mesh(
                new THREE.PlaneGeometry(
                    400,
                    0.18
                ),
                lineMat
            );

        line.rotation.x =
            -Math.PI / 2;

        line.rotation.z =
            rot;

        line.position.y =
            0.02;

        state.scene.add(line);
    }
}


// ============================================================
// BUILDINGS
// ============================================================

function createBuildings() {

    const colors = [
        0xd9e5ef,
        0xf0d6b6,
        0xcbd9c7,
        0xe5c7d9,
        0xd4d0ee
    ];

    for (
        let x = -150;
        x <= 150;
        x += 35
    ) {

        for (
            let z = -150;
            z <= 150;
            z += 35
        ) {

            if (
                Math.abs(x) < 25 ||
                Math.abs(z) < 25
            ) {
                continue;
            }

            const w =
                14 +
                Math.random() * 8;

            const h =
                5 +
                Math.random() * 10;

            const d =
                14 +
                Math.random() * 8;


            const building =
                new THREE.Mesh(
                    new THREE.BoxGeometry(
                        w,
                        h,
                        d
                    ),
                    new THREE.MeshStandardMaterial({
                        color:
                            colors[
                                Math.floor(
                                    Math.random() *
                                    colors.length
                                )
                            ]
                    })
                );


            building.position.set(
                x +
                    Math.random() * 8 -
                    4,

                h / 2,

                z +
                    Math.random() * 8 -
                    4
            );


            building.castShadow = true;
            building.receiveShadow = true;

            state.scene.add(building);


            const roof =
                new THREE.Mesh(
                    new THREE.ConeGeometry(
                        Math.max(w, d) * 0.72,
                        4,
                        4
                    ),
                    new THREE.MeshStandardMaterial({
                        color: 0x8a5d4b
                    })
                );


            roof.position.set(
                building.position.x,
                h + 2,
                building.position.z
            );


            roof.rotation.y =
                Math.PI / 4;

            roof.castShadow = true;

            state.scene.add(roof);
        }
    }
}


// ============================================================
// TREES
// ============================================================

function createTrees() {

    for (
        let i = 0;
        i < 170;
        i++
    ) {

        const x =
            Math.random() * 370 - 185;

        const z =
            Math.random() * 370 - 185;


        if (
            Math.abs(x) < 15 ||
            Math.abs(z) < 15
        ) {
            continue;
        }


        const tree =
            new THREE.Group();


        const trunk =
            new THREE.Mesh(
                new THREE.CylinderGeometry(
                    0.18,
                    0.25,
                    2,
                    8
                ),
                new THREE.MeshStandardMaterial({
                    color: 0x76513b
                })
            );


        trunk.position.y = 1;
        trunk.castShadow = true;

        tree.add(trunk);


        const leaves =
            new THREE.Mesh(
                new THREE.SphereGeometry(
                    1.5,
                    10,
                    8
                ),
                new THREE.MeshStandardMaterial({
                    color: 0x2f873f
                })
            );


        leaves.position.y = 2.8;
        leaves.castShadow = true;

        tree.add(leaves);


        tree.position.set(
            x,
            0,
            z
        );

        state.scene.add(tree);
    }
}


// ============================================================
// PLAYER MOVEMENT
// ============================================================

function updatePlayer(dt) {

    if (!state.localPlayer) {
        return;
    }

    const player =
        state.localPlayer;


    // Защита от неправильных координат

    if (
        !Number.isFinite(
            player.position.x
        ) ||
        !Number.isFinite(
            player.position.y
        ) ||
        !Number.isFinite(
            player.position.z
        )
    ) {

        player.position.set(
            0,
            0,
            0
        );

        state.velocityY = 0;
        state.grounded = true;
    }


    const w =
        !!state.keys["KeyW"];

    const s =
        !!state.keys["KeyS"];

    const a =
        !!state.keys["KeyA"];

    const d =
        !!state.keys["KeyD"];


    let moveX = 0;
    let moveZ = 0;


    // Направление вперёд относительно камеры

    const forwardX =
        Math.sin(state.yaw);

    const forwardZ =
        Math.cos(state.yaw);


    // Направление вправо

    const rightX =
        Math.cos(state.yaw);

    const rightZ =
        -Math.sin(state.yaw);


    // W

    if (w) {
        moveX += forwardX;
        moveZ += forwardZ;
    }


    // S

    if (s) {
        moveX -= forwardX;
        moveZ -= forwardZ;
    }


    // A

    if (a) {
        moveX -= rightX;
        moveZ -= rightZ;
    }


    // D

    if (d) {
        moveX += rightX;
        moveZ += rightZ;
    }


    // Нормализация

    const length =
        Math.hypot(
            moveX,
            moveZ
        );


    if (length > 0) {

        moveX /= length;
        moveZ /= length;


        const speed = 7;


        player.position.x +=
            moveX *
            speed *
            dt;


        player.position.z +=
            moveZ *
            speed *
            dt;


        // Поворачиваем персонажа
        // в сторону движения

        player.rotation.y =
            Math.atan2(
                moveX,
                moveZ
            );
    }


    // ========================================================
    // GRAVITY / JUMP
    // ========================================================

    state.velocityY -=
        18 * dt;


    player.position.y +=
        state.velocityY * dt;


    if (
        player.position.y <= 0
    ) {

        player.position.y = 0;

        state.velocityY = 0;

        state.grounded = true;
    }


    // ========================================================
    // WORLD LIMITS
    // ========================================================

    const LIMIT = 190;


    player.position.x =
        THREE.MathUtils.clamp(
            player.position.x,
            -LIMIT,
            LIMIT
        );


    player.position.z =
        THREE.MathUtils.clamp(
            player.position.z,
            -LIMIT,
            LIMIT
        );


    if (
        !Number.isFinite(
            player.position.y
        )
    ) {

        player.position.y = 0;

        state.velocityY = 0;
    }


    player.position.y =
        Math.max(
            0,
            Math.min(
                100,
                player.position.y
            )
        );


    // ========================================================
    // SEND POSITION
    // ========================================================

    const now =
        performance.now();


    if (
        now - state.lastSent > 50 &&
        state.ws &&
        state.ws.readyState ===
            WebSocket.OPEN
    ) {

        send({

            type: "move",

            position: {

                x: Number(
                    player.position.x
                ),

                y: Number(
                    player.position.y
                ),

                z: Number(
                    player.position.z
                )
            },

            rotation: Number(
                player.rotation.y
            )
        });


        state.lastSent = now;
    }
}


// ============================================================
// CAMERA
// ============================================================

function updateCamera() {

    if (!state.localPlayer) {
        return;
    }


    const target =
        state.localPlayer.position.clone();


    target.y +=
        Math.max(
            1.2,
            state.height * 1.25
        );


    const horizontal =
        Math.cos(
            state.pitch
        ) *
        state.cameraDistance;


    const vertical =
        Math.sin(
            state.pitch
        ) *
        state.cameraDistance;


    const camX =
        target.x -
        Math.sin(
            state.yaw
        ) *
        horizontal;


    const camZ =
        target.z -
        Math.cos(
            state.yaw
        ) *
        horizontal;


    const camY =
        target.y +
        vertical;


    state.camera.position.lerp(
        new THREE.Vector3(
            camX,
            camY,
            camZ
        ),
        0.12
    );


    state.camera.lookAt(
        target
    );
}


// ============================================================
// REMOTE PLAYERS
// ============================================================

function updateRemotePlayers() {

    for (
        const mesh
        of state.remotePlayers.values()
    ) {

        if (
            mesh.userData.targetPosition
        ) {

            mesh.position.lerp(
                mesh.userData.targetPosition,
                0.18
            );


            // Плавный поворот

            let difference =
                mesh.userData.targetRotation -
                mesh.rotation.y;


            // Исправляем переход
            // через -PI / PI

            difference =
                Math.atan2(
                    Math.sin(difference),
                    Math.cos(difference)
                );


            mesh.rotation.y +=
                difference * 0.18;
        }
    }
}


// ============================================================
// MINIMAP
// ============================================================

function drawMinimap() {

    const w =
        mapCanvas.width;

    const h =
        mapCanvas.height;


    mapCtx.clearRect(
        0,
        0,
        w,
        h
    );


    mapCtx.fillStyle =
        "#1d5530";

    mapCtx.fillRect(
        0,
        0,
        w,
        h
    );


    // Дороги

    mapCtx.fillStyle =
        "#3d4148";


    mapCtx.fillRect(
        0,
        h / 2 - 7,
        w,
        14
    );


    mapCtx.fillRect(
        w / 2 - 7,
        0,
        14,
        h
    );


    const scale =
        w /
        state.worldSize;


    const toMap =
        (x, z) => ({

            x:
                w / 2 +
                x * scale,

            y:
                h / 2 +
                z * scale
        });


    // Другие игроки

    for (
        const mesh
        of state.remotePlayers.values()
    ) {

        if (
            !Number.isFinite(
                mesh.position.x
            ) ||
            !Number.isFinite(
                mesh.position.z
            )
        ) {
            continue;
        }


        const p =
            toMap(
                mesh.position.x,
                mesh.position.z
            );


        mapCtx.fillStyle =
            "#ff5577";


        mapCtx.beginPath();


        mapCtx.arc(
            p.x,
            p.y,
            4,
            0,
            Math.PI * 2
        );


        mapCtx.fill();
    }


    // Наш игрок

    if (
        state.localPlayer
    ) {

        const p =
            toMap(
                state.localPlayer.position.x,
                state.localPlayer.position.z
            );


        mapCtx.fillStyle =
            "#42a5ff";


        mapCtx.beginPath();


        mapCtx.arc(
            p.x,
            p.y,
            5,
            0,
            Math.PI * 2
        );


        mapCtx.fill();
    }
}


// ============================================================
// ANIMATION LOOP
// ============================================================

let lastTime =
    performance.now();


function animate() {

    requestAnimationFrame(
        animate
    );


    const now =
        performance.now();


    const dt =
        Math.min(
            (now - lastTime) / 1000,
            0.05
        );


    lastTime = now;


    updatePlayer(dt);

    updateRemotePlayers();

    updateCamera();

    drawMinimap();


    if (
        state.renderer &&
        state.scene &&
        state.camera
    ) {

        state.renderer.render(
            state.scene,
            state.camera
        );
    }
}


// ============================================================
// LOGIN
// ============================================================

startButton.addEventListener(
    "click",
    () => {

        const name =
            nameInput.value.trim() ||
            "Player";


        state.name =
            name;


        localStorage.setItem(
            "growworld_name",
            name
        );


        loginStatus.textContent =
            "Подключение...";


        connect();
    }
);


nameInput.addEventListener(
    "keydown",
    e => {

        if (
            e.key === "Enter"
        ) {

            startButton.click();
        }
    }
);


// ============================================================
// GROW
// ============================================================

growButton.addEventListener(
    "click",
    () => {

        send({
            type: "grow"
        });
    }
);


// ============================================================
// CHAT
// ============================================================

chatForm.addEventListener(
    "submit",
    e => {

        e.preventDefault();


        const text =
            chatInput.value.trim();


        if (!text) {
            return;
        }


        send({

            type: "chat",

            text
        });


        chatInput.value = "";
    }
);


// ============================================================
// KEYBOARD
// ============================================================

window.addEventListener(
    "keydown",
    e => {

        // Не мешаем печатать
        // в имени и чате

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

            state.keys[e.code] =
                true;
        }


        if (
            e.code === "Space"
        ) {

            e.preventDefault();


            if (
                state.grounded
            ) {

                state.velocityY =
                    7;

                state.grounded =
                    false;
            }
        }
    }
);


window.addEventListener(
    "keyup",
    e => {

        if (
            e.code === "KeyW" ||
            e.code === "KeyA" ||
            e.code === "KeyS" ||
            e.code === "KeyD"
        ) {

            e.preventDefault();

            state.keys[e.code] =
                false;
        }
    }
);


// ============================================================
// RESIZE
// ============================================================

window.addEventListener(
    "resize",
    () => {

        if (
            !state.camera ||
            !state.renderer
        ) {
            return;
        }


        state.camera.aspect =
            innerWidth /
            innerHeight;


        state.camera.updateProjectionMatrix();


        state.renderer.setSize(
            innerWidth,
            innerHeight
        );
    }
);


// ============================================================
// START
// ============================================================

createWorld();
