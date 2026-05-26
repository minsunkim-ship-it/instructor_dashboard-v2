"""모든 drive_satisfaction pending에 split-sheet-by-instructor apply 직접 호출"""
import json, io, sys, os, urllib.request, urllib.parse, ssl, time
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

SECRET = os.environ["CRON_SECRET"]
ctx = ssl.create_default_context()

all_rows = []
for off in [0,100,200,300]:
    try:
        with open(rf"C:\Users\Day1_김민선\Downloads\instructor_db\p{off}.json", "rb") as f:
            all_rows.extend(json.loads(f.read()).get("rows", []))
    except: pass

# drive_satisfaction + 회사 명시 + 비공공
PUBLIC_KW = ["대학교","학교","진흥원","회의소","공단","연구원","공사","수력원자력","교육원","벤처캐피탈","과기대","과학기술원"]
def is_public(co):
    return co and any(k in co for k in PUBLIC_KW)

GENERIC = {"원데이","공개형 교육","공개교육","특강","워크숍","상반기","프롬프트 엔지니어링"}

drive_rows = [
    r for r in all_rows
    if r.get("sourceType") == "drive_satisfaction"
    and r.get("company") and not is_public(r.get("company"))
    and r.get("company") not in GENERIC
    and len(r.get("company","")) >= 3
]
print(f"대상: {len(drive_rows)}건")

applied = 0
errors = 0
total_records = 0
no_responses = 0
for i, r in enumerate(drive_rows):
    rk = r.get("registryKey")
    co = r.get("company")
    crs = (r.get("course") or "")[:30]
    rk_enc = urllib.parse.quote(rk, safe="")
    url = f"https://instructor-dashboard.skillflo.app/api/admin/split-sheet-by-instructor?mode=apply&registry_key={rk_enc}"
    try:
        req = urllib.request.Request(url, method="POST", headers={"x-cron-secret": SECRET})
        with urllib.request.urlopen(req, timeout=60, context=ctx) as resp:
            d = json.loads(resp.read())
        if d.get("ok"):
            created = d.get("created", 0)
            total_records += created
            applied += 1
            if i < 30:
                print(f"  ✓ {co[:14]:14s} | {crs:30s} | created={created}")
        else:
            errors += 1
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read())
            err = body.get("error", str(e))
            if err == "no_valid_responses":
                no_responses += 1
            errors += 1
            if i < 30:
                print(f"  ✗ {co[:14]:14s} | {err}")
        except:
            errors += 1
    except Exception as e:
        errors += 1
    time.sleep(0.2)

print(f"\nApplied: {applied}/{len(drive_rows)}")
print(f"Created records: {total_records}")
print(f"Errors: {errors} (no_valid_responses: {no_responses})")
