"""Browser-compatible HTTP/2 transport adapted from the supplied MIT-licensed code."""
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from queue import Queue, Full, Empty
import threading

from curl_cffi import Curl, CurlHttpVersion, CurlOpt
import httpx

MAX_STREAMS = 8
MAX_STREAM_QUEUE_CHUNKS = 8
_stream_executor = ThreadPoolExecutor(max_workers=MAX_STREAMS, thread_name_prefix="media-stream")
_stream_local = threading.local()


class CurlStreamClient:
    def build_request(self, method, url, headers):
        return method, url, headers

    def send(self, request, stream=True):
        return CurlStreamResponse(*request)

    def close(self):
        pass


class CurlStreamResponse:
    def __init__(self, method, url, headers):
        self.headers = httpx.Headers()
        self.status_code = 0
        self.queue = Queue(maxsize=MAX_STREAM_QUEUE_CHUNKS)
        self.stopped = threading.Event()
        self.ready = threading.Event()
        self.finished = threading.Event()
        self.error = None

        def header(data):
            line = data.decode("iso-8859-1").strip()
            if line.startswith("HTTP/"):
                self.status_code = int(line.split()[1])
                self.headers = httpx.Headers()
            elif ":" in line:
                key, value = line.split(":", 1)
                self.headers[key.strip()] = value.strip()
            elif not line and self.status_code >= 200:
                self.ready.set()
            return len(data)

        def write(data):
            while not self.stopped.is_set():
                try:
                    self.queue.put(data, timeout=0.2)
                    return len(data)
                except Full:
                    continue
            return 0

        def perform():
            curl = getattr(_stream_local, "curl", None)
            try:
                if curl is None:
                    curl = Curl()
                    _stream_local.curl = curl
                else:
                    # Reset headers and callbacks while retaining the connection cache.
                    curl.reset()
                curl.impersonate("chrome")
                curl.setopt(CurlOpt.HTTP_VERSION, CurlHttpVersion.V2_0)
                curl.setopt(CurlOpt.URL, url.encode())
                curl.setopt(CurlOpt.HTTPHEADER, [f"{key}: {value}".encode() for key, value in headers.items()])
                curl.setopt(CurlOpt.FOLLOWLOCATION, 0)
                curl.setopt(CurlOpt.SUPPRESS_CONNECT_HEADERS, 1)
                curl.setopt(CurlOpt.CONNECTTIMEOUT, 12)
                curl.setopt(CurlOpt.LOW_SPEED_LIMIT, 1)
                curl.setopt(CurlOpt.LOW_SPEED_TIME, 90)
                curl.setopt(CurlOpt.HEADERFUNCTION, header)
                curl.setopt(CurlOpt.WRITEFUNCTION, write)
                if method == "HEAD":
                    curl.setopt(CurlOpt.NOBODY, 1)
                curl.perform()
            except Exception as error:
                self.error = error
            finally:
                self.finished.set()
                self.ready.set()

        self.future = _stream_executor.submit(perform)
        if not self.ready.wait(25) or not self.status_code:
            self.close()
            raise ValueError("Media connection failed")

    def iter_raw(self, size=65536):
        while not self.finished.is_set() or not self.queue.empty():
            try:
                yield self.queue.get(timeout=0.2)
            except Empty:
                continue
        if self.error and not self.stopped.is_set():
            raise ValueError("Media transfer interrupted") from None

    iter_bytes = iter_raw

    def close(self):
        self.stopped.set()
        try:
            self.future.result(timeout=1.5)
        except FutureTimeout:
            pass
