import os
import json
import asyncio
from datetime import datetime, timezone
from typing import Dict

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pymongo import MongoClient

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MONGODB_URI = os.getenv("MONGODB_URI")

app = FastAPI(title="GrowWorld")

mongo_client = None
players_collection = None

if MONGODB_URI:
    mongo_client = MongoClient(
        MONGODB_URI,
        serverSelectionTimeoutMS=5000
    )
    db = mongo_client["GrowWorld"]
    players_collection = db["players"]

connections: Dict[str, WebSocket] = {}
players: Dict[str, dict] = {}
lock = asyncio.Lock()


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def public_player(p):
    return {
        "id": p["id"],
        "name": p["name"],
        "height": p["height"],
        "position": p["position"],
        "rotation": p["rotation"],
    }


def load_player(player_id, name):
    if players_collection is not None:
        saved = players_collection.find_one({"_id": player_id})
        if saved:
            pos = saved.get("position", {})
            return {
                "id": player_id,
                "name": str(saved.get("name", name))[:24] or "Player",
                "height": float(saved.get("height", 1.0)),
                "position": {
                    "x": float(pos.get("x", 0)),
                    "y": float(pos.get("y", 0)),
                    "z": float(pos.get("z", 0)),
                },
                "rotation": float(saved.get("rotation", 0)),
            }

    return {
        "id": player_id,
        "name": name[:24] or "Player",
        "height": 1.0,
        "position": {"x": 0.0, "y": 0.0, "z": 0.0},
        "rotation": 0.0,
    }


def save_player(p):
    if players_collection is None:
        return

    players_collection.update_one(
        {"_id": p["id"]},
        {"$set": {
            "name": p["name"],
            "height": p["height"],
            "position": p["position"],
            "rotation": p["rotation"],
            "updatedAt": datetime.now(timezone.utc),
        }},
        upsert=True,
    )


async def send(ws, payload):
    await ws.send_text(json.dumps(payload))


async def broadcast(payload, exclude=None):
    message = json.dumps(payload)
    async with lock:
        targets = list(connections.items())

    dead = []
    for pid, ws in targets:
        if pid == exclude:
            continue
        try:
            await ws.send_text(message)
        except Exception:
            dead.append(pid)

    for pid in dead:
        connections.pop(pid, None)
        players.pop(pid, None)


@app.get("/")
async def home():
    return FileResponse(os.path.join(BASE_DIR, "index.html"))


app.mount("/static", StaticFiles(directory=BASE_DIR), name="static")


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    player_id = None
    player = None

    try:
        raw = await websocket.receive_text()
        data = json.loads(raw)

        if data.get("type") != "join":
            await websocket.close(code=1008)
            return

        player_id = str(data.get("id", "")).strip()
        name = str(data.get("name", "Player")).strip()[:24]

        if not player_id:
            await websocket.close(code=1008)
            return

        player = load_player(player_id, name)

        async with lock:
            players[player_id] = player
            connections[player_id] = websocket

        await send(websocket, {
            "type": "welcome",
            "player": public_player(player),
            "players": [
                public_player(p)
                for pid, p in players.items()
                if pid != player_id
            ],
        })

        await broadcast({
            "type": "player_joined",
            "player": public_player(player),
        }, exclude=player_id)

        while True:
            data = json.loads(await websocket.receive_text())
            msg_type = data.get("type")

            if msg_type == "move":
                pos = data.get("position", {})
                player["position"] = {
                    "x": clamp(float(pos.get("x", 0)), -190, 190),
                    "y": clamp(float(pos.get("y", 0)), 0, 50),
                    "z": clamp(float(pos.get("z", 0)), -190, 190),
                }
                player["rotation"] = float(data.get("rotation", 0))

                await broadcast({
                    "type": "player_moved",
                    "player": public_player(player),
                }, exclude=player_id)

            elif msg_type == "grow":
                # Every accepted click adds exactly 1 cm.
                player["height"] = round(player["height"] + 0.01, 2)

                await send(websocket, {
                    "type": "height_updated",
                    "height": player["height"],
                })

                await broadcast({
                    "type": "player_grew",
                    "player": public_player(player),
                }, exclude=player_id)

            elif msg_type == "chat":
                text = str(data.get("text", "")).strip()[:180]
                if text:
                    await broadcast({
                        "type": "chat",
                        "name": player["name"],
                        "playerId": player_id,
                        "text": text,
                    })

            elif msg_type == "ping":
                await send(websocket, {"type": "pong"})

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        print("WebSocket error:", exc)
    finally:
        if player_id and player:
            save_player(player)
            async with lock:
                connections.pop(player_id, None)
                players.pop(player_id, None)

            await broadcast({
                "type": "player_left",
                "playerId": player_id,
            })
