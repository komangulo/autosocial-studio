@echo off
setlocal EnableDelayedExpansion
if not exist "downloads" mkdir downloads

set /p CHANNEL="Enter the TikTok channel URL or username (e.g. @username): "
if "!CHANNEL!"=="" (
    echo No channel entered. Exiting.
    goto done
)

set /p MIN_VIEWS="Enter the minimum view count filter (press Enter for no filter): "

set YTDLP_ARGS=-o "downloads/%%(uploader)s/%%(upload_date)s_%%(id)s.%%(ext)s" --write-description -S vcodec:h264,res,acodec

if not "!MIN_VIEWS!"=="" (
    echo Downloading videos from https://www.tiktok.com/!CHANNEL!...
    .\yt-dlp.exe !YTDLP_ARGS! --match-filter "view_count >= !MIN_VIEWS!" https://www.tiktok.com/!CHANNEL!
) else (
    echo Downloading videos from https://www.tiktok.com/!CHANNEL!...
    .\yt-dlp.exe !YTDLP_ARGS! https://www.tiktok.com/!CHANNEL!
)

echo Download complete.
:done
endlocal
pause
