"""Anonymous, bounded YouTube URL resolution for the local vision worker."""
from __future__ import annotations

import re
import shutil
from dataclasses import dataclass
from urllib.parse import urlsplit

VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
ALLOWED_LIVE_STATUS = {"is_live", "not_live", "was_live", "post_live", "is_upcoming", "unknown"}


class YoutubeSourceError(RuntimeError):
    """A safe, user-facing YouTube source error without upstream URL details."""


@dataclass(frozen=True)
class YoutubeVideo:
    video_id: str
    title: str
    is_live: bool | None
    live_status: str | None
    media_url: str  # Short-lived CDN URL. Keep in worker memory only.


def youtube_video_id(raw_url: str) -> str:
    """Accept only canonical single-video YouTube URL forms."""
    try:
        parsed = urlsplit(raw_url)
        hostname = (parsed.hostname or "").lower().rstrip(".")
        if parsed.scheme not in ("http", "https") or parsed.username or parsed.password or parsed.port:
            raise ValueError
        if hostname in ("youtube.com", "www.youtube.com", "m.youtube.com"):
            parts = [part for part in parsed.path.split("/") if part]
            if parsed.path == "/watch":
                from urllib.parse import parse_qs
                values = parse_qs(parsed.query, keep_blank_values=True).get("v", [])
                video_id = values[0] if len(values) == 1 else ""
            elif len(parts) == 2 and parts[0] == "live":
                video_id = parts[1]
            else:
                raise ValueError
        elif hostname == "youtu.be":
            parts = [part for part in parsed.path.split("/") if part]
            video_id = parts[0] if len(parts) == 1 else ""
        else:
            raise ValueError
    except (ValueError, UnicodeError):
        raise YoutubeSourceError("Enter a public YouTube video, live, or youtu.be link.") from None
    if not VIDEO_ID.fullmatch(video_id):
        raise YoutubeSourceError("The YouTube link does not contain a valid video ID.")
    return video_id


def canonical_youtube_url(video_id: str) -> str:
    if not VIDEO_ID.fullmatch(video_id):
        raise YoutubeSourceError("The YouTube link does not contain a valid video ID.")
    return f"https://www.youtube.com/watch?v={video_id}"


def resolve_youtube_video(raw_url: str, *, max_height: int = 1080) -> YoutubeVideo:
    """Resolve one video-only stream. No cookies, proxy, headers, or playlist use."""
    video_id = youtube_video_id(raw_url)
    try:
        import yt_dlp
    except Exception:
        raise YoutubeSourceError("The YouTube resolver is not installed in this vision runtime.") from None

    dependencies = getattr(yt_dlp, "dependencies", None)
    if getattr(dependencies, "yt_dlp_ejs", None) is None:
        raise YoutubeSourceError("Local YouTube challenge scripts are missing. Install the pinned yt-dlp EJS support package.")
    node_path = shutil.which("node") or shutil.which("node.exe")
    if not node_path:
        raise YoutubeSourceError("Local YouTube challenge support needs Node.js 22 or newer on PATH.")

    class SilentLogger:
        missing_js_runtime = False
        missing_ejs_scripts = False

        def debug(self, _message: str) -> None: pass
        def info(self, _message: str) -> None: pass
        def warning(self, message: str) -> None:
            lowered = str(message).lower()
            self.missing_js_runtime |= "no supported javascript runtime" in lowered
            self.missing_ejs_scripts |= (
                "yt-dlp-ejs" in lowered
                or "javascript challenge scripts are not installed" in lowered
                or "could not find javascript challenge scripts" in lowered
            )
        def error(self, _message: str) -> None: pass

    logger = SilentLogger()
    options = {
        "logger": logger,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "noplaylist": True,
        "skip_download": True,
        "cachedir": False,
        "socket_timeout": 12,
        "retries": 1,
        "fragment_retries": 1,
        "extractor_retries": 1,
        # Node is an explicit local runtime. Remote JavaScript components remain disabled;
        # the matching, pinned EJS package is installed with the worker environment.
        "js_runtimes": {"node": {"path": node_path}},
        # Every fallback remains capped. An unrestricted `best` can choose
        # 1440p/4K when the preferred video-only format is absent.
        "format": f"bestvideo[height<={max_height}]/best[height<={max_height}]",
    }
    try:
        with yt_dlp.YoutubeDL(options) as client:
            info = client.extract_info(canonical_youtube_url(video_id), download=False)
    except Exception as error:
        # yt-dlp errors can contain signed CDN URLs. Never return or log them.
        message = str(error).lower()
        if "sign in to confirm" in message or "not a bot" in message:
            detail = "YouTube refused this anonymous request. The link may require sign-in or be temporarily restricted; account cookies are not used."
        elif logger.missing_js_runtime or "no supported javascript runtime" in message:
            detail = "Local YouTube challenge support needs Node.js 22 or newer."
        elif logger.missing_ejs_scripts or "yt-dlp-ejs" in message:
            detail = "Local YouTube challenge scripts are missing. Install the pinned yt-dlp EJS support package."
        elif "timed out" in message or "timeout" in message:
            detail = "YouTube did not respond before the resolver timed out. Try again later."
        else:
            detail = "YouTube could not provide a playable video stream. The link may be unavailable or restricted."
        raise YoutubeSourceError(detail) from None

    if not isinstance(info, dict) or str(info.get("id", "")) != video_id:
        raise YoutubeSourceError("YouTube returned metadata for a different video.")
    media_url = info.get("url")
    if not isinstance(media_url, str) or not media_url.startswith(("https://", "http://")):
        raise YoutubeSourceError("YouTube did not provide a playable video stream.")
    live_status = info.get("live_status")
    if live_status not in ALLOWED_LIVE_STATUS:
        live_status = "unknown"
    is_live = info.get("is_live") if isinstance(info.get("is_live"), bool) else None
    if is_live is None and live_status != "unknown":
        is_live = live_status == "is_live"
    return YoutubeVideo(
        video_id=video_id,
        title=str(info.get("title") or "YouTube video")[:200],
        is_live=is_live,
        live_status=live_status,
        media_url=media_url,
    )
