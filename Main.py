import os
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pymongo import MongoClient
import httpx
from fastapi import HTTPException

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")

app = FastAPI()

# =========================
# MongoDB
# =========================

MONGODB_URI = os.getenv("MONGODB_URI")
ROBLOX_API_KEY = os.getenv("ROBLOX_API_KEY")
mongo_client = None
db = None
players_collection = None

if MONGODB_URI:
    try:
        mongo_client = MongoClient(
            MONGODB_URI,
            serverSelectionTimeoutMS=5000
        )

        db = mongo_client["GrowWorld"]
        players_collection = db["players"]

        print("MongoDB configured successfully")

    except Exception as e:
        print("MongoDB configuration error:", e)


# =========================
# Static
# =========================

app.mount(
    "/static",
    StaticFiles(directory=STATIC_DIR),
    name="static"
)


@app.get("/")
async def root():
    return FileResponse(
        os.path.join(BASE_DIR, "index.html")
    )


# =========================
# Players
# =========================

players = {}
connected = {}


def safe_float(value, default=0.0):
    """
    Безопасно превращает значение в float.
    None, NaN и неправильные значения заменяются default.
    """

    try:
        if value is None:
            return default

        result = float(value)

        if result != result:
            return default

        return result

    except (TypeError, ValueError):
        return default


def load_player(player_id, name):

    if players_collection is not None:

        try:

            saved = players_collection.find_one({
                "_id": player_id
            })

            if saved:

                return {
                    "id": player_id,

                    "name": (
                        name
                        or saved.get("name")
                        or "Player"
                    ),
                    
                    "robloxUserId": saved.get(
                        "robloxUserId"
                    ),

                    "height": max(
                        0.01,
                        min(
                            safe_float(
                                saved.get("height"),
                                1.0
                            ),
                            100.0
                        )
                    ),

                    "position": {
                        "x": safe_float(
                            saved.get("x"),
                            0.0
                        ),

                        "y": max(
                            0.0,
                            safe_float(
                                saved.get("y"),
                                0.0
                            )
                        ),

                        "z": safe_float(
                            saved.get("z"),
                            0.0
                        )
                    },

                    "rotation": safe_float(
                        saved.get("rotation"),
                        0.0
                    )
                }

        except Exception as e:

            print(
                "MongoDB load error:",
                e
            )


    # Новый игрок

    return {
        "id": player_id,

        "name": name or "Player",

        "height": 1.0,

        "position": {
            "x": 0.0,
            "y": 0.0,
            "z": 0.0
        },

        "rotation": 0.0
    }


def save_player(player):

    if players_collection is None:
        return

    try:

        position = player.get(
            "position",
            {}
        )

        players_collection.update_one(

            {
                "_id": player["id"]
            },

            {
                "$set": {

                    "name": player.get(
                        "name",
                        "Player"
                    ),
                    "robloxUserId": player.get(
                        "robloxUserId"
                    ),

                    "height": safe_float(
                        player.get(
                            "height",
                            1.0
                        ),
                        1.0
                    ),

                    "x": safe_float(
                        position.get("x"),
                        0.0
                    ),

                    "y": max(
                        0.0,
                        safe_float(
                            position.get("y"),
                            0.0
                        )
                    ),

                    "z": safe_float(
                        position.get("z"),
                        0.0
                    ),

                    "rotation": safe_float(
                        player.get("rotation"),
                        0.0
                    )
                }
            },

            upsert=True
        )

    except Exception as e:

        print(
            "MongoDB save error:",
            e
        )


# =========================
# Broadcast
# =========================

async def broadcast(
    message,
    exclude=None
):

    disconnected = []

    for player_id, websocket in list(
        connected.items()
    ):

        if player_id == exclude:
            continue

        try:

            await websocket.send_json(
                message
            )

        except Exception:

            disconnected.append(
                player_id
            )


    for player_id in disconnected:

        connected.pop(
            player_id,
            None
        )

@app.get("/roblox/avatar/{user_id}")
async def get_roblox_avatar(user_id: int):

    if not ROBLOX_API_KEY:
        raise HTTPException(
            status_code=500,
            detail="ROBLOX_API_KEY не настроен на сервере."
        )

    if user_id <= 0:
        raise HTTPException(
            status_code=400,
            detail="Некорректный Roblox User ID."
        )

    url = (
        "https://thumbnails.roblox.com"
        "/v1/users/avatar-3d"
    )

    headers = {
        "x-api-key": ROBLOX_API_KEY
    }

    params = {
        "userId": user_id
    }

    try:
        async with httpx.AsyncClient(
            timeout=15.0
        ) as client:

            response = await client.get(
                url,
                headers=headers,
                params=params
            )

        if response.status_code != 200:
            print(
                "Roblox API error:",
                response.status_code,
                response.text
            )

            raise HTTPException(
                status_code=response.status_code,
                detail="Roblox API вернул ошибку."
            )

        return response.json()

    except httpx.RequestError as e:

        print(
            "Roblox connection error:",
            e
        )

        raise HTTPException(
            status_code=502,
            detail="Не удалось связаться с Roblox."
        )

# =========================
# Roblox 3D Avatar Test
# =========================

@app.get("/roblox/test-files/{user_id}")
async def test_roblox_files(user_id: int):

    if not ROBLOX_API_KEY:
        raise HTTPException(
            status_code=500,
            detail="ROBLOX_API_KEY не настроен."
        )

    if user_id <= 0:
        raise HTTPException(
            status_code=400,
            detail="Некорректный Roblox User ID."
        )

    avatar_url = (
        "https://thumbnails.roblox.com"
        "/v1/users/avatar-3d"
    )

    headers = {
        "x-api-key": ROBLOX_API_KEY
    }

    params = {
        "userId": user_id
    }

    try:

        async with httpx.AsyncClient(
            timeout=30.0,
            follow_redirects=True
        ) as client:

            # -------------------------
            # 1. Получаем manifest
            # -------------------------

            response = await client.get(
                avatar_url,
                headers=headers,
                params=params
            )

            if response.status_code != 200:
                raise HTTPException(
                    status_code=response.status_code,
                    detail={
                        "message": "Roblox Avatar API error",
                        "response": response.text
                    }
                )

            data = response.json()

            print(
                "Roblox avatar response:",
                data
            )

            if data.get("state") != "Completed":
                return {
                    "success": False,
                    "state": data.get("state"),
                    "message": "Avatar ещё не готов."
                }

            image_url = data.get("imageUrl")

            if not image_url:
                raise HTTPException(
                    status_code=502,
                    detail="Roblox не вернул imageUrl."
                )

            # -------------------------
            # 2. Получаем OBJ manifest
            # -------------------------

            obj_response = await client.get(
                image_url
            )

            if obj_response.status_code != 200:
                raise HTTPException(
                    status_code=obj_response.status_code,
                    detail={
                        "message": "Не удалось получить OBJ manifest",
                        "status": obj_response.status_code
                    }
                )

            manifest = obj_response.json()

            print(
                "Roblox 3D manifest:",
                manifest
            )

            obj_id = manifest.get("obj")
            mtl_id = manifest.get("mtl")
            textures = manifest.get(
                "textures",
                []
            )

            if not obj_id:
                raise HTTPException(
                    status_code=502,
                    detail="В manifest отсутствует obj."
                )

            if not mtl_id:
                raise HTTPException(
                    status_code=502,
                    detail="В manifest отсутствует mtl."
                )

            # -------------------------
            # 3. Формируем CDN URL
            # -------------------------

            obj_url = (
                "https://t1.rbxcdn.com/"
                + obj_id
            )

            mtl_url = (
                "https://t1.rbxcdn.com/"
                + mtl_id
            )

            # -------------------------
            # 4. Скачиваем OBJ
            # -------------------------

            obj_file = await client.get(
                obj_url
            )

            print(
                "OBJ status:",
                obj_file.status_code
            )

            print(
                "OBJ size:",
                len(obj_file.content)
            )

            # -------------------------
            # 5. Скачиваем MTL
            # -------------------------

            mtl_file = await client.get(
                mtl_url
            )

            print(
                "MTL status:",
                mtl_file.status_code
            )

            print(
                "MTL size:",
                len(mtl_file.content)
            )

            # -------------------------
            # 6. Возвращаем результат
            # -------------------------

            return {
                "success": True,

                "userId": user_id,

                "state": data.get(
                    "state"
                ),

                "obj": {
                    "id": obj_id,
                    "url": obj_url,
                    "status": obj_file.status_code,
                    "size": len(
                        obj_file.content
                    )
                },

                "mtl": {
                    "id": mtl_id,
                    "url": mtl_url,
                    "status": mtl_file.status_code,
                    "size": len(
                        mtl_file.content
                    )
                },

                "textures": {
                    "count": len(textures),
                    "ids": textures
                }
            }

    except httpx.RequestError as e:

        print(
            "Roblox CDN request error:",
            e
        )

        raise HTTPException(
            status_code=502,
            detail=(
                "Ошибка соединения с Roblox CDN."
            )
        )

# =========================
# Roblox 3D Avatar Assets
# =========================

ROBLOX_CDN = "https://t1.rbxcdn.com/"


@app.get("/roblox/avatar-data/{user_id}")
async def get_roblox_avatar_data(user_id: int):

    if not ROBLOX_API_KEY:
        raise HTTPException(
            status_code=500,
            detail="ROBLOX_API_KEY не настроен."
        )

    if user_id <= 0:
        raise HTTPException(
            status_code=400,
            detail="Некорректный Roblox User ID."
        )

    avatar_url = (
        "https://thumbnails.roblox.com"
        "/v1/users/avatar-3d"
    )

    headers = {
        "x-api-key": ROBLOX_API_KEY
    }

    try:

        async with httpx.AsyncClient(
            timeout=30.0,
            follow_redirects=True
        ) as client:

            response = await client.get(
                avatar_url,
                headers=headers,
                params={
                    "userId": user_id
                }
            )

            if response.status_code != 200:
                raise HTTPException(
                    status_code=response.status_code,
                    detail="Roblox Avatar API error."
                )

            data = response.json()

            if data.get("state") != "Completed":

                return {
                    "success": False,
                    "state": data.get("state"),
                    "message": "Roblox avatar ещё не готов."
                }

            image_url = data.get("imageUrl")

            if not image_url:
                raise HTTPException(
                    status_code=502,
                    detail="Roblox не вернул imageUrl."
                )

            manifest_response = await client.get(
                image_url
            )

            if manifest_response.status_code != 200:
                raise HTTPException(
                    status_code=502,
                    detail="Не удалось получить Roblox 3D manifest."
                )

            manifest = manifest_response.json()

            obj_id = manifest.get("obj")
            mtl_id = manifest.get("mtl")

            if not obj_id:
                raise HTTPException(
                    status_code=502,
                    detail="Roblox manifest не содержит OBJ."
                )

            if not mtl_id:
                raise HTTPException(
                    status_code=502,
                    detail="Roblox manifest не содержит MTL."
                )

            return {
                "success": True,
                "userId": user_id,

                "obj": obj_id,

                "mtl": mtl_id,

                "textures": manifest.get(
                    "textures",
                    []
                ),

                "aabb": manifest.get(
                    "aabb"
                ),

                "camera": manifest.get(
                    "camera"
                )
            }

    except httpx.RequestError as e:

        print(
            "Roblox avatar data error:",
            e
        )

        raise HTTPException(
            status_code=502,
            detail="Ошибка соединения с Roblox."
        )


@app.get("/roblox/asset/{asset_id:path}")
async def roblox_asset(asset_id: str):

    asset_id = asset_id.strip()

    # Убираем возможные расширения
    for extension in (
        ".png",
        ".jpg",
        ".jpeg",
        ".webp",
        ".tga",
        ".obj",
        ".mtl"
    ):
        if asset_id.lower().endswith(extension):
            asset_id = asset_id[
                :-len(extension)
            ]

    if not asset_id:
        raise HTTPException(
            status_code=400,
            detail="Invalid Roblox asset ID"
        )

    # -------------------------------------------------
    # Roblox 30DAY assets
    # -------------------------------------------------

    if asset_id.startswith("30DAY-"):

        # Roblox CDN может использовать разные
        # t0-t7 хосты.
        #
        # Проверяем их последовательно, пока
        # не найдём рабочий.

        cdn_hosts = [
            "https://t0.rbxcdn.com",
            "https://t1.rbxcdn.com",
            "https://t2.rbxcdn.com",
            "https://t3.rbxcdn.com",
            "https://t4.rbxcdn.com",
            "https://t5.rbxcdn.com",
            "https://t6.rbxcdn.com",
            "https://t7.rbxcdn.com",
        ]

    else:

        cdn_hosts = [
            "https://t1.rbxcdn.com"
        ]

    headers = {
        "User-Agent": (
            "Mozilla/5.0 "
            "(Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 "
            "(KHTML, like Gecko) "
            "Chrome/140 Safari/537.36"
        ),
        "Accept": "*/*",
    }

    async with httpx.AsyncClient(
        timeout=30,
        follow_redirects=True
    ) as client:

        for host in cdn_hosts:

            url = (
                f"{host}/{asset_id}"
            )

            try:

                print(
                    "Trying Roblox CDN:",
                    url
                )

                response = await client.get(
                    url,
                    headers=headers
                )

                if response.status_code == 200:

                    content_type = (
                        response.headers.get(
                            "content-type"
                        )
                        or "application/octet-stream"
                    )

                    print(
                        "Roblox CDN SUCCESS:",
                        url,
                        content_type,
                        len(response.content)
                    )

                    return Response(
                        content=response.content,
                        media_type=content_type,
                        headers={
                            "Cache-Control":
                                "public, max-age=86400"
                        }
                    )

                print(
                    "Roblox CDN failed:",
                    response.status_code,
                    url
                )

            except Exception as error:

                print(
                    "Roblox CDN request error:",
                    url,
                    repr(error)
                )

    raise HTTPException(
        status_code=502,
        detail="Roblox CDN returned error."
    )

# =========================
# WebSocket
# =========================

@app.websocket("/ws")
async def websocket_endpoint(
    websocket: WebSocket
):

    await websocket.accept()

    player_id = None

    try:

        # =========================
        # JOIN
        # =========================

        first_message = (
            await websocket.receive_json()
        )

        if first_message.get(
            "type"
        ) != "join":

            await websocket.close()
            return


        # =========================
        # Player ID
        # =========================

        player_id = str(
            first_message.get(
                "id"
            )
            or ""
        )

        if not player_id:

            await websocket.close()
            return


        # =========================
        # Player name
        # =========================

        name = str(
            first_message.get(
                "name",
                "Player"
            )
            or "Player"
        )[:24]


        # =========================
        # Roblox User ID
        # =========================

        roblox_user_id = safe_float(
            first_message.get(
                "robloxUserId"
            ),
            0
        )

        roblox_user_id = int(
            roblox_user_id
        )


        # =========================
        # Load player
        # =========================

        player = load_player(
            player_id,
            name
        )


        player["name"] = name


        player["robloxUserId"] = (
            roblox_user_id
            if roblox_user_id > 0
            else None
        )


        # =========================
        # Add to online players
        # =========================

        players[player_id] = player

        connected[player_id] = websocket


        # =========================
        # WELCOME
        # =========================

        other_players = [

            p

            for pid, p in players.items()

            if pid != player_id

        ]


        await websocket.send_json({

            "type": "welcome",

            "player": player,

            "players": other_players

        })


        # =========================
        # Notify other players
        # =========================

        await broadcast({

            "type": "player_joined",

            "player": player

        }, exclude=player_id)


        # =========================
        # MAIN LOOP
        # =========================

        while True:

            data = (
                await websocket.receive_json()
            )

            message_type = data.get(
                "type"
            )


            # =========================
            # MOVE
            # =========================

            if message_type == "move":

                position = data.get(
                    "position"
                ) or {}


                x = safe_float(
                    position.get("x"),
                    player["position"]["x"]
                )

                y = safe_float(
                    position.get("y"),
                    player["position"]["y"]
                )

                z = safe_float(
                    position.get("z"),
                    player["position"]["z"]
                )

                rotation = safe_float(
                    data.get("rotation"),
                    player.get(
                        "rotation",
                        0.0
                    )
                )


                # =========================
                # World boundaries
                # =========================

                x = max(
                    -190.0,
                    min(190.0, x)
                )

                y = max(
                    0.0,
                    min(100.0, y)
                )

                z = max(
                    -190.0,
                    min(190.0, z)
                )


                player["position"] = {

                    "x": x,

                    "y": y,

                    "z": z

                }

                player["rotation"] = rotation


                await broadcast({

                    "type":
                        "player_moved",

                    "player":
                        player

                }, exclude=player_id)


            # =========================
            # GROW
            # =========================

            elif message_type == "grow":

                player["height"] = min(

                    100.0,

                    safe_float(
                        player.get(
                            "height",
                            1.0
                        ),
                        1.0
                    ) + 0.01

                )


                save_player(
                    player
                )


                await websocket.send_json({

                    "type":
                        "height_updated",

                    "height":
                        player["height"]

                })


                await broadcast({

                    "type":
                        "player_grew",

                    "player":
                        player

                }, exclude=player_id)


            # =========================
            # CHAT
            # =========================

            elif message_type == "chat":

                text = str(
                    data.get(
                        "text",
                        ""
                    )
                    or ""
                ).strip()


                if not text:
                    continue


                text = text[:300]


                await broadcast({

                    "type": "chat",

                    "name":
                        player["name"],

                    "text":
                        text

                })


    # =========================
    # Disconnect
    # =========================

    except WebSocketDisconnect:

        pass


    except Exception as e:

        print(
            "WebSocket error:",
            e
        )


    # =========================
    # Cleanup
    # =========================

    finally:

        if player_id:

            player = players.get(
                player_id
            )


            if player:

                save_player(
                    player
                )


            connected.pop(
                player_id,
                None
            )


            players.pop(
                player_id,
                None
            )


            try:

                await broadcast({

                    "type":
                        "player_left",

                    "playerId":
                        player_id

                })


            except Exception:

                pass
