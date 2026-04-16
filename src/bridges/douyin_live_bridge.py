import argparse
import gzip
import json
import os
import re
import sys
import threading
import time
from datetime import datetime, timezone
from urllib.parse import urlencode

import requests
from websocket import WebSocketApp


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def utc_now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def to_safe_getattr(obj, attr, default=None):
    return getattr(obj, attr, default) if obj is not None else default


def parse_args():
    parser = argparse.ArgumentParser(description="Douyin live message bridge")
    parser.add_argument("--live-id", required=True, help="live web rid from live.douyin.com/<live_id>")
    parser.add_argument("--source-root", required=True, help="DouYin_Spider project root path")
    parser.add_argument("--duration", type=int, default=0, help="max run duration in seconds, 0 means unlimited")
    parser.add_argument("--cookies", default="", help="DY_LIVE_COOKIES")
    return parser.parse_args()


class LiveBridge:
    def __init__(self, args):
        self.args = args
        self.ws = None
        self.started_at = time.time()

        source_root = args.source_root
        if source_root not in sys.path:
            sys.path.insert(0, source_root)

        from builder.auth import DouyinAuth
        from builder.header import HeaderBuilder
        from builder.params import Params
        from dy_apis.douyin_api import DouyinAPI
        from utils.dy_util import generate_signature
        import static.Live_pb2 as Live_pb2

        self.DouyinAuth = DouyinAuth
        self.HeaderBuilder = HeaderBuilder
        self.Params = Params
        self.DouyinAPI = DouyinAPI
        self.generate_signature = generate_signature
        self.Live_pb2 = Live_pb2

    def ensure_ttwid_cookie(self, auth):
        if auth.cookie.get("ttwid"):
            return auth.cookie.get("ttwid")

        try:
            response = requests.get(
                "https://live.douyin.com/",
                headers={
                    "user-agent": self.HeaderBuilder.ua,
                    "accept-language": "zh-CN,zh;q=0.9",
                },
                timeout=10,
                verify=False,
            )
            ttwid = response.cookies.get_dict().get("ttwid")
            if ttwid:
                auth.cookie["ttwid"] = ttwid
                auth.cookie_str = "; ".join([f"{k}={v}" for k, v in auth.cookie.items()])
                return ttwid
        except Exception:
            pass

        return None

    def get_live_info_fallback(self, auth, live_id):
        url = "https://live.douyin.com/" + live_id
        response = requests.get(
            url,
            headers={
                "user-agent": self.HeaderBuilder.ua,
                "accept-language": "zh-CN,zh;q=0.9",
            },
            cookies=auth.cookie,
            verify=False,
            timeout=12,
        )

        text = response.text
        if "验证码中间页" in text or "captcha/index.js" in text:
            raise RuntimeError("captcha_required")

        ttwid = response.cookies.get_dict().get("ttwid") or auth.cookie.get("ttwid") or self.ensure_ttwid_cookie(auth)
        room_id_match = re.findall(r'\\"roomId\\":\\"(\d+)\\"', text)
        user_id_match = re.findall(r'\\"user_unique_id\\":\\"(\d+)\\"', text)
        if not room_id_match or not user_id_match:
            raise RuntimeError("room_info_not_found")

        return {
            "room_id": room_id_match[0],
            "user_id": user_id_match[0],
            "ttwid": ttwid,
        }

    def should_stop(self):
        if self.args.duration <= 0:
            return False
        return (time.time() - self.started_at) >= self.args.duration

    def ping(self, ws):
        while True:
            if self.should_stop():
                ws.close()
                break
            frame = self.Live_pb2.PushFrame()
            frame.payloadType = "hb"
            try:
                ws.send(frame.SerializeToString(), opcode=0x02)
                time.sleep(5)
            except Exception:
                ws.close()
                break

    def on_open(self, ws):
        emit({"type": "bridge_state", "state": "opened", "time": utc_now_iso(), "liveId": self.args.live_id})
        threading.Thread(target=self.ping, args=(ws,), daemon=True).start()

    def parse_event(self, room_id, item):
        method = item.method
        payload = item.payload

        if method == "WebcastChatMessage":
            msg = self.Live_pb2.ChatMessage()
            msg.ParseFromString(payload)
            return {
                "eventType": "chat",
                "messageType": method,
                "messageId": str(to_safe_getattr(to_safe_getattr(msg, "common"), "msg_id", "")) or None,
                "roomId": room_id,
                "eventTime": utc_now_iso(),
                "userId": to_safe_getattr(to_safe_getattr(msg, "user"), "sec_uid"),
                "userName": to_safe_getattr(to_safe_getattr(msg, "user"), "nickname"),
                "content": to_safe_getattr(msg, "content"),
            }

        if method == "WebcastLikeMessage":
            msg = self.Live_pb2.LikeMessage()
            msg.ParseFromString(payload)
            return {
                "eventType": "like",
                "messageType": method,
                "messageId": str(to_safe_getattr(to_safe_getattr(msg, "common"), "msg_id", "")) or None,
                "roomId": room_id,
                "eventTime": utc_now_iso(),
                "userId": to_safe_getattr(to_safe_getattr(msg, "user"), "sec_uid"),
                "userName": to_safe_getattr(to_safe_getattr(msg, "user"), "nickname"),
                "content": f"点赞 {to_safe_getattr(msg, 'count', 0)} 次，总点赞 {to_safe_getattr(msg, 'total', 0)}",
            }

        if method == "WebcastMemberMessage":
            msg = self.Live_pb2.MemberMessage()
            msg.ParseFromString(payload)
            return {
                "eventType": "member",
                "messageType": method,
                "messageId": str(to_safe_getattr(to_safe_getattr(msg, "common"), "msg_id", "")) or None,
                "roomId": room_id,
                "eventTime": utc_now_iso(),
                "userId": to_safe_getattr(to_safe_getattr(msg, "user"), "sec_uid"),
                "userName": to_safe_getattr(to_safe_getattr(msg, "user"), "nickname"),
                "content": "进入直播间",
            }

        if method == "WebcastGiftMessage":
            msg = self.Live_pb2.GiftMessage()
            msg.ParseFromString(payload)
            return {
                "eventType": "gift",
                "messageType": method,
                "messageId": str(to_safe_getattr(to_safe_getattr(msg, "common"), "msg_id", "")) or None,
                "roomId": room_id,
                "eventTime": utc_now_iso(),
                "userId": to_safe_getattr(to_safe_getattr(msg, "user"), "sec_uid"),
                "userName": to_safe_getattr(to_safe_getattr(msg, "user"), "nickname"),
                "content": "送出礼物",
                "giftName": to_safe_getattr(to_safe_getattr(msg, "gift"), "name"),
                "giftCount": to_safe_getattr(msg, "comboCount"),
            }

        if method == "WebcastSocialMessage":
            msg = self.Live_pb2.SocialMessage()
            msg.ParseFromString(payload)
            if to_safe_getattr(msg, "action") == 1:
                return {
                    "eventType": "follow",
                    "messageType": method,
                    "messageId": str(to_safe_getattr(to_safe_getattr(msg, "common"), "msg_id", "")) or None,
                    "roomId": room_id,
                    "eventTime": utc_now_iso(),
                    "userId": to_safe_getattr(to_safe_getattr(msg, "user"), "sec_uid"),
                    "userName": to_safe_getattr(to_safe_getattr(msg, "user"), "nickname"),
                    "content": "关注主播",
                }
            return None

        if method == "WebcastRoomStatsMessage":
            msg = self.Live_pb2.RoomStatsMessage()
            msg.ParseFromString(payload)
            return {
                "eventType": "room_stats",
                "messageType": method,
                "messageId": str(to_safe_getattr(to_safe_getattr(msg, "common"), "msg_id", "")) or None,
                "roomId": room_id,
                "eventTime": utc_now_iso(),
                "content": to_safe_getattr(msg, "displayLong"),
            }

        return None

    def on_message(self, ws, message):
        try:
            frame = self.Live_pb2.PushFrame()
            frame.ParseFromString(message)
            origin_bytes = gzip.decompress(frame.payload)
            response = self.Live_pb2.LiveResponse()
            response.ParseFromString(origin_bytes)

            if response.needAck:
                ack = self.Live_pb2.PushFrame()
                ack.payloadType = "ack"
                ack.payload = response.internalExt.encode("utf-8")
                ack.logId = frame.logId
                ws.send(ack.SerializeToString(), opcode=0x02)

            for item in response.messagesList:
                parsed = self.parse_event(self.room_id, item)
                if parsed:
                    emit({"type": "message", **parsed})

            if self.should_stop():
                ws.close()
        except Exception as error:
            emit({"type": "bridge_error", "error": str(error), "time": utc_now_iso()})

    def on_error(self, ws, error):
        emit({"type": "bridge_error", "error": str(error), "time": utc_now_iso()})

    def on_close(self, ws, close_status_code, close_msg):
        emit(
            {
                "type": "bridge_state",
                "state": "closed",
                "statusCode": close_status_code,
                "closeMsg": close_msg,
                "time": utc_now_iso(),
            }
        )

    def start(self):
        auth = self.DouyinAuth()
        auth.perepare_auth(self.args.cookies, "", "")
        self.ensure_ttwid_cookie(auth)
        try:
            room_info = self.DouyinAPI.get_live_info(auth, self.args.live_id)
        except Exception:
            room_info = self.get_live_info_fallback(auth, self.args.live_id)
        if not room_info:
            emit({"type": "bridge_error", "error": "failed_to_get_live_info", "liveId": self.args.live_id})
            raise RuntimeError("failed_to_get_live_info")

        room_id = room_info["room_id"]
        user_id = room_info["user_id"]
        ttwid = room_info["ttwid"]
        self.room_id = room_id

        params = self.Params()
        (params
         .add_param("app_name", "douyin_web")
         .add_param("version_code", "180800")
         .add_param("webcast_sdk_version", "1.0.14-beta.0")
         .add_param("update_version_code", "1.0.14-beta.0")
         .add_param("compress", "gzip")
         .add_param("device_platform", "web")
         .add_param("cookie_enabled", "true")
         .add_param("screen_width", "1707")
         .add_param("screen_height", "960")
         .add_param("browser_language", "zh-CN")
         .add_param("browser_platform", "Win32")
         .add_param("browser_name", "Mozilla")
         .add_param("browser_version", self.HeaderBuilder.ua.split("Mozilla/")[-1])
         .add_param("browser_online", "true")
         .add_param("tz_name", "Etc/GMT-8")
         .add_param("host", "https://live.douyin.com")
         .add_param("aid", "6383")
         .add_param("live_id", "1")
         .add_param("did_rule", "3")
         .add_param("endpoint", "live_pc")
         .add_param("support_wrds", "1")
         .add_param("user_unique_id", str(user_id))
         .add_param("im_path", "/webcast/im/fetch/")
         .add_param("identity", "audience")
         .add_param("need_persist_msg_count", "15")
         .add_param("insert_task_id", "")
         .add_param("live_reason", "")
         .add_param("room_id", room_id)
         .add_param("heartbeatDuration", "0")
         .add_param("signature", self.generate_signature(room_id, user_id)))
        wss_url = f"wss://webcast5-ws-web-lf.douyin.com/webcast/im/push/v2/?{urlencode(params.get())}"

        emit(
            {
                "type": "bridge_state",
                "state": "connecting",
                "liveId": self.args.live_id,
                "roomId": room_id,
                "time": utc_now_iso(),
            }
        )

        self.ws = WebSocketApp(
            url=wss_url,
            header={
                "Pragma": "no-cache",
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
                "User-Agent": self.HeaderBuilder.ua,
                "Upgrade": "websocket",
                "Cache-Control": "no-cache",
                "Connection": "Upgrade",
            },
            cookie=f"ttwid={ttwid};",
            on_message=self.on_message,
            on_error=self.on_error,
            on_close=self.on_close,
            on_open=self.on_open,
        )
        self.ws.run_forever(origin="https://live.douyin.com")


def main():
    args = parse_args()

    if not args.cookies:
        emit({"type": "bridge_error", "error": "missing_dy_live_cookies"})
        sys.exit(2)

    if not os.path.exists(args.source_root):
        emit({"type": "bridge_error", "error": "invalid_source_root", "sourceRoot": args.source_root})
        sys.exit(2)

    bridge = LiveBridge(args)
    try:
        bridge.start()
    except Exception as error:
        emit({"type": "bridge_error", "error": str(error), "hint": "check_full_live_cookies"})
        sys.exit(1)


if __name__ == "__main__":
    main()
