import os
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pymongo import MongoClient

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")

app = FastAPI()

# =========================
# MongoDB
# =========================

MONGODB_URI = os.getenv("MONGODB_URI")

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


        player_id = str(
            first_message.get(
                "id"
            )
            or ""
        )

        if not player_id:

            await websocket.close()
            return


        name = str(
            first_message.get(
                "name",
                "Player"
            )
            or "Player"
        )[:24]


        player = load_player(
            player_id,
            name
        )

        player["name"] = name


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


                # Границы мира

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


                save_player(player)


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


    except WebSocketDisconnect:

        pass

    except Exception as e:

        print(
            "WebSocket error:",
            e
        )

    finally:

        if player_id:

            player = players.get(
                player_id
            )

            if player:

                save_player(player)


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
