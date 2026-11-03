#!/usr/bin/env python3
# server/src/services/workflow/control-flow/qa-remediation-file-owner.py
#
# [purpose] C5 — qa remediation 게시의 '커널 소유' 배타적 파일 기록 helper. 부모(Node)가 DB 권한을
#   재확인하는 동안 이 프로세스가 대상 정규 경로의 guard 파일에 flock(LOCK_EX) 을 실제 보유하고,
#   모든 실제 IO(temp 기록/fsync/chmod/rename/재읽기 검증/디렉터리 fsync)도 이 프로세스 안에서만
#   수행한다. 부모 Node FS 가 보호된 대상에 직접 쓰지 않는다.
# [protocol] stdin/stdout private stdio — 한 줄 JSON, v=1(정수, bool 아님), 요청 id 는 비어있지 않은
#   bounded 문자열이고 오류 응답은 유효한 현재 요청 id 를 보존한다(id 파악 전 오류는 null). lock_wait 는
#   무상관 이벤트(비차단 경합 양성 신호). begin(전 guard 획득 후에만 ready) → publish* → close(또는
#   EOF). 순차 처리 — 응답이 동기 IO 를 앞지칠 수 없고 lock 은 close/EOF 까지 유지된다.
# [safety] guard 파일은 절대 unlink/재생성하지 않는다(정리는 fd close 뿐). guard 는 정규 파일·전용
#   모드(group/world writable 거부)·현재 uid 소유·nlink 1, lock 획득 뒤 경로 lstat dev/ino 가 보유 fd 와
#   정확 일치해야 한다(교체 거부). lockRoot 는 명시적 정규 실재 전용 디렉터리, 대상은 절대 정규경로·
#   심볼릭·중복 거부, 게시 항목은 보유 target 정확 소속·2MB 상한·sha256/size 형식 검증. before 불일치는
#   mismatch_held 로 절대 덮어쓰지 않고 after 일치만 skip, 항목별 IO OSError 는 그 항목 io_error + 이후
#   not_attempted 로 실제 이력 보존(재시도 없음). 권한의 원천은 DB 예약 — 부모가 guard 획득 후 재검증.

import base64, errno, fcntl, hashlib, json, os, re, stat, sys, tempfile
V = 1
MAX_LINE_BYTES = 8 * 1024 * 1024
MAX_FILE_BYTES = 2 * 1024 * 1024  # QA_REMEDIATION_MAX_FILE_BYTES (qa-remediation-contract.ts) 와 동일
MAX_ID_BYTES = 256
class Refusal(Exception):
    def __init__(self, code, message):
        super().__init__(message); self.code, self.message = code, message

def send(obj):
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()
_BUF = b""

def read_line():  # 개행 종결 한 줄만 읽는다 — 상한 초과/EOF 잔여물은 typed 거부
    global _BUF
    while b"\n" not in _BUF:
        if len(_BUF) > MAX_LINE_BYTES:
            raise Refusal("line_too_long", "input line exceeds frame cap")
        chunk = os.read(0, 65536)
        if not chunk:
            if _BUF.strip():
                raise Refusal("bad_json", "eof mid-line")
            return None
        _BUF += chunk
    line, _, _BUF = _BUF.partition(b"\n")
    if len(line) > MAX_LINE_BYTES:
        raise Refusal("line_too_long", "input line exceeds frame cap")
    return line.decode("utf-8")

def require_canonical_path(p, what):  # 절대 정규경로 문자열 + (존재 시) 심볼릭/비정규 구성 거부
    if not isinstance(p, str) or not p.startswith("/") or "\x00" in p or os.path.normpath(p) != p:
        raise Refusal("bad_" + what, f"{what} must be an absolute canonical path string: {p!r}")
    if os.path.lexists(p) and (os.path.islink(p) or os.path.realpath(p) != p):
        raise Refusal("alias_refused", f"{what} resolves through a symlink component: {p}")
def open_guard_fd(lock_root, target):  # guard 열기·전용성 검증·lock·획득 후 경로 inode 일치 재확인
    gp = os.path.join(lock_root, "c5-" + hashlib.sha256(target.encode("utf-8")).hexdigest() + ".guard")
    fd = os.open(gp, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        held = os.fstat(fd)
        if not stat.S_ISREG(held.st_mode):
            raise Refusal("bad_guard", f"guard is not a regular file: {gp}")
        if stat.S_IMODE(held.st_mode) & 0o022:
            raise Refusal("unsafe_guard", f"guard is group or world writable: {gp}")
        if held.st_nlink != 1 or held.st_uid != os.getuid():
            raise Refusal("bad_guard", f"guard must be a single-link file owned by the current uid: {gp}")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as wait:
            if wait.errno not in (errno.EAGAIN, errno.EWOULDBLOCK, errno.EACCES):
                raise
            send({"v": V, "type": "lock_wait", "target": target})
            fcntl.flock(fd, fcntl.LOCK_EX)  # 차단 대기 — 타임아웃/나이는 권한이 아니다
        named = os.lstat(gp)  # 보유 fd 와 경로가 같은 객체를 가리키는가(교체 감지)
        if not stat.S_ISREG(named.st_mode) or named.st_dev != held.st_dev or named.st_ino != held.st_ino:
            raise Refusal("guard_replaced", f"guard path no longer matches the locked inode: {gp}")
        return fd
    except BaseException:
        os.close(fd)
        raise

def classify(target, item):  # 현재 bytes 분류 — after: skip / before: apply / 그 외: mismatch_held(미기록)
    try:
        if os.path.islink(target) or os.path.realpath(target) != target:
            return "mismatch_held", "target resolves through a symlink", None, None
        st = os.stat(target)
        if not stat.S_ISREG(st.st_mode):
            return "mismatch_held", "target is not a regular file", None, None
        with open(target, "rb") as handle:
            data = handle.read(MAX_FILE_BYTES + 1)
        digest = hashlib.sha256(data).hexdigest()
        if len(data) > MAX_FILE_BYTES:
            return "mismatch_held", "current bytes exceed file cap", digest, len(data)
        if digest == item["afterSha256"] and len(data) == item["afterSize"]:
            return "already_applied", None, digest, len(data)
        if digest == item["beforeSha256"] and len(data) == item["beforeSize"]:
            return "apply", stat.S_IMODE(st.st_mode), digest, len(data)
        return "mismatch_held", "bytes match neither before nor after identity", digest, len(data)
    except OSError as error:
        if error.errno == errno.ENOENT:
            return "mismatch_held", "target missing", None, None
        return "io_error", f"preflight failed: {error}", None, None

def fsync_dir(directory):
    fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
def write_atomically(target, data, mode, after_sha, after_size):  # temp→fsync→chmod→rename→재읽기→dir fsync
    directory = os.path.dirname(target)
    fd, temp = tempfile.mkstemp(prefix=".c5pub-", dir=directory)
    try:
        view = memoryview(data)
        while view:
            view = view[os.write(fd, view):]
        os.fsync(fd)
        os.fchmod(fd, mode)
        os.close(fd)
        fd = -1
        os.replace(temp, target)
        temp = None
        with open(target, "rb") as handle:
            readback = handle.read()
        if hashlib.sha256(readback).hexdigest() != after_sha or len(readback) != after_size:
            return f"readback does not match declared after identity for {target}"
        fsync_dir(directory)
        return None
    finally:
        if fd >= 0:
            os.close(fd)
        if temp is not None:
            try:
                os.unlink(temp)  # temp 만 정리 — guard 파일은 절대 unlink 하지 않는다
            except FileNotFoundError:
                pass

def int_field(container, key, where):
    value = container.get(key)
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise Refusal("bad_items", f"{where}.{key} must be a non-negative integer")
    return value

def _io_report(files, detail):  # 파일별 실제 결과 보존 — io_error 이후 미시도만 not_attempted
    rows, seen_failure = [], False
    for row in files:
        if seen_failure and row["status"] in ("apply", "already_applied"):
            rows.append({**row, "status": "not_attempted", "detail": "not attempted: earlier io failure"})
        else:
            rows.append(dict(row))
        if row["status"] == "io_error":
            seen_failure = True
    return {"type": "publish_result", "ok": False, "outcome": "io_error", "files": rows, "detail": detail}

def handle_publish(msg, guards):
    items = msg.get("items")
    if not isinstance(items, list) or not items:
        raise Refusal("bad_items", "items must be a non-empty list")
    plan, seen = [], set()
    for entry in items:
        if not isinstance(entry, dict):
            raise Refusal("bad_items", "each item must be an object")
        target = entry.get("target")
        if target not in guards:
            raise Refusal("item_out_of_scope", f"target is not a held guard target: {target!r}")
        if target in seen:
            raise Refusal("duplicate_items", f"duplicate publish item for target: {target}")
        seen.add(target)
        if any(not isinstance(entry.get(k), str) or re.fullmatch(r"[0-9a-f]{64}", entry[k]) is None for k in ("beforeSha256", "afterSha256")):
            raise Refusal("bad_items", "item.beforeSha256/afterSha256 must be lowercase hex sha256 strings")
        item = {"beforeSha256": entry["beforeSha256"], "afterSha256": entry["afterSha256"], "beforeSize": int_field(entry, "beforeSize", "item"), "afterSize": int_field(entry, "afterSize", "item")}
        try:
            data = base64.b64decode(entry.get("bytesB64", ""), validate=True)
        except Exception as error:
            raise Refusal("bad_items", f"bytesB64 is not valid base64: {error}")
        if len(data) > MAX_FILE_BYTES:
            raise Refusal("bytes_over_cap", f"desired bytes exceed cap for {target}")
        if hashlib.sha256(data).hexdigest() != item["afterSha256"] or len(data) != item["afterSize"]:
            raise Refusal("identity_mismatch", f"desired bytes do not match declared after identity for {target}")
        plan.append((target, item, data))
    # preflight: 전 항목 분류가 끝나기 전에는 아무 기록도 하지 않는다.
    classified = [(target, item, data) + classify(target, item) for target, item, data in plan]
    files = [{"target": target, "status": status, "detail": info or status, "observedSha256": digest, "observedSize": size} for target, item, data, status, info, digest, size in classified]
    cause = next((row for row in files if row["status"] == "mismatch_held"), None)
    if cause:
        for row in files:
            if row["status"] in ("apply", "already_applied"):
                row["status"] = "held"
                row["detail"] = "not written: preflight held before any write"
        return {"type": "publish_result", "ok": False, "outcome": "held", "files": files,
                "detail": f"preflight held: {cause['detail']}"}
    preflight_io = next((row for row in files if row["status"] == "io_error"), None)
    if preflight_io:
        return _io_report(files, f"preflight io failure: {preflight_io['detail']}")

    results = []
    for index, (target, item, data, status, info, digest, size) in enumerate(classified):
        if status == "already_applied":
            try:
                fsync_dir(os.path.dirname(target)); failure = None  # 직전 rename 이 dir fsync 전에 죽었을 수 있다
            except OSError as error:
                failure = f"directory barrier failed: {error}"
            if failure:
                failed = {**files[index], "status": "io_error", "detail": failure}
                return _io_report(results + [failed] + files[index + 1:], f"publication io failure at {target}: {failure}")
            results.append({"target": target, "status": "already_applied",
                            "detail": "verified at declared after identity under held guard",
                            "observedSha256": digest, "observedSize": size})
            continue
        try:  # 항목별 실제 IO OSError — 이 항목만 io_error, 이전 실제 결과는 보존된다
            failure = write_atomically(target, data, info, item["afterSha256"], item["afterSize"])
        except OSError as error:
            failure = f"io failure: {error}"
        if failure:
            failed = {**files[index], "status": "io_error", "detail": failure}
            return _io_report(results + [failed] + files[index + 1:], f"publication io failure at {target}: {failure}")
        results.append({"target": target, "status": "applied",
                        "detail": f"exclusive temp + atomic rename + readback verified ({len(data)} bytes)",
                        "observedSha256": item["afterSha256"], "observedSize": item["afterSize"]})
    return {"type": "publish_result", "ok": True, "outcome": "published", "files": results,
            "detail": f"{len(results)} files at declared after identity under held guard"}

def main():
    guards, begun = {}, False
    while True:
        line = read_line()
        if line is None:  # EOF — lock 은 프로세스 종료로 해제된다(guard 파일은 남는다)
            return 0
        rid, valid_id = None, False
        try:
            msg = json.loads(line)
            if not isinstance(msg, dict):
                raise Refusal("bad_json", "frame is not a JSON object")
            rid = msg.get("id")
            valid_id = isinstance(rid, str) and 0 < len(rid) <= MAX_ID_BYTES
            if not isinstance(msg.get("v"), int) or isinstance(msg.get("v"), bool) or msg.get("v") != V:
                raise Refusal("bad_version", "unsupported protocol version")
            if not valid_id:
                raise Refusal("bad_request_id", "request id must be a non-empty bounded string")
            op = msg.get("op")
            if op == "begin":
                if begun:
                    raise Refusal("already_begun", "begin requested twice")
                lock_root, targets = msg.get("lockRoot"), msg.get("targets")
                require_canonical_path(lock_root, "lock_root")
                root_st = os.stat(lock_root)
                if not stat.S_ISDIR(root_st.st_mode):
                    raise Refusal("bad_lock_root", "lockRoot is not a directory")
                if stat.S_IMODE(root_st.st_mode) & 0o022:
                    raise Refusal("unsafe_lock_root", "lockRoot is group or world writable")
                if not isinstance(targets, list) or not targets:
                    raise Refusal("targets_empty", "targets must be a non-empty list")
                for target in targets:
                    require_canonical_path(target, "target")
                if len(set(targets)) != len(targets):
                    raise Refusal("duplicate_targets", "targets contains duplicates")
                guards = {}
                try:
                    for target in sorted(targets):
                        guards[target] = open_guard_fd(lock_root, target)
                except BaseException:
                    for fd in guards.values(): os.close(fd)
                    raise
                begun = True
                send({"v": V, "id": rid, "type": "ready", "targets": sorted(guards)})
            elif op == "publish":
                if not begun:
                    raise Refusal("not_begun", "publish before begin")
                reply = handle_publish(msg, guards)
                reply.update(v=V, id=rid)
                send(reply)  # lock 유지 — close/EOF 까지 (동기 IO 완료 뒤에만 응답)
            elif op == "close":
                if not begun:
                    raise Refusal("not_begun", "close before begin")
                for fd in guards.values():
                    os.close(fd)  # guard 파일 자체는 절대 unlink 하지 않는다
                guards = {}
                send({"v": V, "id": rid, "type": "closed"})
                return 0
            else:
                raise Refusal("unknown_op", f"unsupported op: {op!r}")
        except ValueError:
            raise Refusal("bad_json", "line is not JSON")
        except Refusal as refusal:  # 유효한 현재 요청 id 를 오류 응답에 보존한다
            send({"v": V, "id": rid if valid_id else None, "type": "error", "code": refusal.code, "message": refusal.message})
            sys.exit(2)

if __name__ == "__main__":
    try:
        sys.exit(main())
    except Refusal as refusal:  # id 파악 전 오류(읽기/JSON 파싱) — id 는 null
        send({"v": V, "id": None, "type": "error", "code": refusal.code, "message": refusal.message})
        sys.exit(2)
    except BrokenPipeError:
        sys.exit(0)  # 부모가 먼저 사라졌다 — lock 은 이 프로세스와 함께 해제
    except Exception as error:  # 예기치 못한 오류 — 절대 삼키지 않고 표면화한다
        try:
            send({"v": V, "id": None, "type": "error", "code": "internal", "message": f"{type(error).__name__}: {error}"})
        except Exception:
            pass
        sys.exit(3)
