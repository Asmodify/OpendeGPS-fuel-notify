# Open Teever driver guide v3: 10-card carousel, one step per card with a phone mockup of the real screen.
# Usage: python3 make_guide_v3.py <assets_dir (base.css, fonts/, icon.png)> <out_dir>
import html, subprocess, sys
from pathlib import Path
S = Path(sys.argv[1]); OUT = Path(sys.argv[2]); OUT.mkdir(parents=True, exist_ok=True)
CH = "/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell"
CSS = """<link rel="stylesheet" href="base.css"><style>
.main{flex:1;padding:60px 72px 40px;display:flex;flex-direction:column;position:relative}
.pg{position:absolute;right:72px;top:60px;font:800 24px Manrope;color:var(--grey);letter-spacing:.1em}
h1{font:900 108px/1 Onest;letter-spacing:-.02em}
h1 em{font-style:normal;color:var(--hivis)}
.head{display:flex;gap:30px;align-items:center;margin-top:44px}
.n{flex:none;width:128px;height:128px;background:var(--hivis);color:var(--coal);font:900 84px/128px Onest;text-align:center;border-radius:22px}
.head b{font:900 70px/1.02 Onest;letter-spacing:-.01em}
.cols{display:flex;gap:44px;margin-top:44px;flex:1}
.txt{flex:1;min-width:0;display:flex;flex-direction:column}
.txt p{font:700 37px/1.38 Manrope;color:#d3d6da}
.txt p strong{color:var(--white)}
.do{margin-top:34px;display:flex;flex-direction:column;gap:18px}
.do div{position:relative;padding-left:34px;font:700 31px/1.5 Manrope;color:#c9cdd2}
.do div:before{content:"";position:absolute;left:0;top:15px;width:16px;height:16px;background:var(--hivis);border-radius:4px}
.do i{font-style:normal;-webkit-box-decoration-break:clone;box-decoration-break:clone;background:#FFCF01;color:#16181c;font-weight:800;padding:2px 12px;border-radius:9px}
.tip{margin-top:auto;background:rgba(255,194,26,.1);border-left:8px solid var(--hivis);padding:22px 26px;font:700 29px/1.35 Manrope;border-radius:0 14px 14px 0}
.tip b{color:var(--hivis)}
/* phone */
.ph{flex:none;width:410px;height:820px;background:#0b0c0e;border-radius:62px;padding:14px;box-shadow:0 0 0 3px #3a3f46,0 30px 60px rgba(0,0,0,.5);position:relative;align-self:flex-start}
.ph:before{content:"";position:absolute;top:26px;left:50%;width:110px;height:30px;margin-left:-55px;background:#0b0c0e;border-radius:20px;z-index:3}
.scr{width:100%;height:100%;background:#F9F9FE;border-radius:50px;overflow:hidden;color:#1b1d21;font-family:Manrope;padding:72px 24px 24px;display:flex;flex-direction:column;gap:12px;position:relative}
.ab{font:800 24px Manrope;color:#16181c;display:flex;align-items:center;gap:12px;margin-bottom:6px}
.ab:before{content:"‹";font:800 34px/1 Manrope;color:#6b7078}
.ab.nob:before{display:none}
.lb{font:700 15px Manrope;color:#6b7078;margin-bottom:-6px}
.in{background:#fff;border:1.5px solid #e1e3ea;border-radius:12px;height:46px;padding:0 14px;font:700 17px/46px Manrope;color:#9aa0a8}
.in.v{color:#1b1d21}
.card{background:#fff;border:1.5px solid #e9eaf0;border-radius:16px;padding:14px 16px;font:700 16px/1.35 Manrope}
.card small{display:block;color:#6b7078;font-size:14px}
.row{display:flex;gap:10px}
.row>*{flex:1}
.ok{color:#1c9a55}
.b{background:#FFCF01;color:#16181c;border-radius:14px;height:54px;font:800 19px/54px Manrope;text-align:center;position:relative}
.b.g{background:#fff;border:1.5px solid #e1e3ea;color:#1b1d21}
.hl{box-shadow:0 0 0 5px #F9F9FE,0 0 0 11px #ff5a1f;z-index:2}
.tap{position:absolute;width:64px;height:64px;border-radius:50%;background:rgba(255,90,31,.35);border:4px solid #ff5a1f;right:26px;bottom:-14px;z-index:4}
.qa{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.qa div{background:#fff;border:1.5px solid #e9eaf0;border-radius:14px;padding:16px 10px;font:800 16px Manrope;text-align:center;position:relative}
.qa div:before{content:"";display:block;width:34px;height:34px;margin:0 auto 8px;border-radius:10px;background:#FFF3BF}
.chk{display:flex;gap:10px;align-items:center;font:700 16px Manrope}
.chk:before{content:"✓";width:24px;height:24px;border-radius:6px;background:#FFCF01;font:900 16px/24px Manrope;text-align:center}
.chk.no:before{content:"";background:#fff;border:1.5px solid #c9ccd4}
.otp{display:flex;gap:8px}
.otp div{flex:1;height:52px;background:#fff;border:1.5px solid #e1e3ea;border-radius:12px;font:800 24px/52px Manrope;text-align:center}
.map{height:150px;border-radius:16px;background:linear-gradient(135deg,#dfe8d8,#cfdccb);position:relative;overflow:hidden}
.map:after{content:"";position:absolute;left:40px;top:30px;width:240px;height:90px;border:5px solid #2f7de1;border-color:#2f7de1 transparent transparent #2f7de1;border-radius:40px 0 0 0}
.chip{display:inline-block;background:#FFF3BF;color:#7a5d00;border-radius:20px;padding:4px 12px;font:800 13px Manrope}
.swipe{margin-top:auto;font:800 40px Manrope;color:var(--hivis);display:flex;align-items:center;gap:16px}
.stores{display:flex;gap:18px;margin-top:40px}
.stores div{background:#000;border:2px solid #3a3f46;border-radius:18px;padding:16px 26px;font:800 30px Manrope}
.stores small{display:block;font:700 17px Manrope;color:var(--grey);letter-spacing:.06em}
.list{margin-top:36px;display:grid;grid-template-columns:1fr 1fr;gap:14px 30px;font:800 32px Manrope}
.list span{color:var(--hivis);font-family:Onest;font-weight:900;margin-right:12px}
</style>"""
BAR = '<div class="bar"><div class="brand">OPEN DEVELOPMENT<small>КОМПАНИЙН КОД, ТУСЛАМЖ</small></div><div class="phone"><small>ЗАЛГАХ</small>8008 5792</div></div>'
T = 10
def page(i, body, kicker="Open Teever · Жолоочийн заавар"):
    return f'<!doctype html><meta charset="utf-8">{CSS}<div class="main"><div class="kicker">{kicker}</div><div class="pg">{i}/{T}</div>{body}</div>{BAR}'
def phone(inner): return f'<div class="ph"><div class="scr">{inner}</div></div>'
def b(t, hl=False, g=False):
    return f'<div class="b{" g" if g else ""}{" hl" if hl else ""}">{html.escape(t)}{"<span class=tap></span>" if hl else ""}</div>'
def stepcard(i, n, title, text, dos, tip, screen):
    d = "".join(f"<div>{x}</div>" for x in dos)
    t = f'<div class="tip">{tip}</div>' if tip else ""
    return page(i, f'<div class="head"><div class="n">{n}</div><b>{title}</b></div>'
                   f'<div class="cols"><div class="txt"><p>{text}</p><div class="do">{d}</div>{t}</div>{phone(screen)}</div>')

STEPS = ["Бүртгүүлэх", "DAN-аар баталгаажуулах", "Мэдээллээ илгээх", "Машин авах", "Ээлж эхлүүлэх", "Даалгавар гүйцэтгэх", "Түлш авсан", "Асуудал, ажлаа дуусгах"]
cards = [
 page(1, f"""<h1 style="margin-top:50px">Open Teever<br>апп-ыг<br><em>алхам алхмаар</em></h1>
 <img src="icon.png" style="position:absolute;right:72px;top:120px;width:160px;border-radius:36px;box-shadow:0 0 0 4px #2c3137">
 <p style="font:700 36px/1.4 Manrope;color:#c9cdd2;margin-top:36px;max-width:900px">Эхлээд апп-аа татаж аваарай. Дараагийн зураг бүр нэг алхам, товчны нэр апп дээрхтэй яг адилхан.</p>
 <div class="stores"><div><small>iPhone</small>App Store</div><div><small>Android</small>Google Play</div></div>
 <div class="list">{"".join(f"<div><span>{k}</span>{s}</div>" for k, s in enumerate(STEPS, 1))}</div>
 <div class="swipe">Гүйлгэж үзээрэй <span style="font-size:48px">→</span></div>"""),
 stepcard(2, 1, "Бүртгүүлэх",
  "Утасны дугаар, нэр, нууц үгээ бичээд <strong>компанийн кодоо</strong> оруулна.",
  ["<i>Бүртгүүлэх</i> дарна", "Утсанд ирсэн SMS кодоо бичээд <i>Баталгаажуулах</i>"],
  "<b>Компанийн код</b> байхгүй бол 8008 5792 руу залгаарай.",
  '<div class="ab">Бүртгүүлэх</div><div class="lb">Утасны дугаар</div><div class="in v">+976 9911 2233</div>'
  '<div class="row"><div><div class="lb">Овог</div><div class="in v" style="margin-top:12px">Дорж</div></div><div><div class="lb">Нэр</div><div class="in v" style="margin-top:12px">Бат</div></div></div>'
  '<div class="lb">Нууц үг</div><div class="in">••••••••</div><div class="lb">Компанийн код</div><div class="in v" style="border-color:#FFCF01;border-width:3px">OPD-0001</div>'
  '<div class="chk">Үйлчилгээний нөхцөлийг зөвшөөрнө</div><div style="margin-top:auto">' + b("Бүртгүүлэх", True) + '</div>'),
 stepcard(3, 2, "DAN-аар баталгаажуулах",
  "Иргэний мэдээлэл, жолооны эрхээ <strong>DAN системээр</strong> нэг дор баталгаажуулна.",
  ["<i>DAN-аар баталгаажуулах</i> дарна", "Нээгдсэн цонхонд нэвтэрч зөвшөөрнө", "Апп руу буцаж ирэхэд ногоон тэмдэг гарна"],
  "Мэдээллийг <b>гараар засах боломжгүй</b>, улсын бүртгэлээс шууд ирнэ.",
  '<div class="ab">DAN баталгаажуулалт</div><div class="card" style="text-align:center;padding:26px 16px"><div style="font:900 44px Onest;color:#1d4fa3">DAN</div><small style="margin-top:8px">Иргэний мэдээллээ DAN-аар баталгаажуулна уу</small></div>'
  '<div class="card"><small>Жолооны үнэмлэх · ДАН/ХУР</small>Жолооны эрх DAN системээр баталгаажна</div>'
  '<div style="margin-top:auto">' + b("DAN-аар баталгаажуулах", True) + '</div>'),
 stepcard(4, 3, "Мэдээллээ илгээх",
  "Нүүр хуудсанд <strong>«Бүртгэлийг дуусгана уу»</strong> гарна. Жагсаалтыг дарааллаар нь бөглөнө.",
  ["Хувийн мэдээлэл, бичиг баримт", "<i>Гэрээ зөвшөөрөх</i>, <i>Гарын үсэг</i>", "Сүүлд нь илгээнэ"],
  "Илгээсний дараа <b>админ хянаж</b>, апп-аар мэдэгдэнэ.",
  '<div class="ab nob">Сайн байна уу, Бат</div><div class="card" style="background:#FFF8D6;border-color:#FFE27A">Бүртгэлийг дуусгана уу<small>3/5 алхам дууссан</small></div>'
  '<div class="card" style="display:flex;flex-direction:column;gap:14px"><div class="chk">Хувийн мэдээлэл</div><div class="chk">DAN баталгаажсан</div><div class="chk">Бичиг баримт</div><div class="chk no">Гэрээ зөвшөөрөх</div><div class="chk no">Гарын үсэг</div></div>'
  '<div style="margin-top:auto">' + b("Гэрээ зөвшөөрөх", True) + '</div>'),
 stepcard(5, 4, "Машин авах",
  "Баталгаажсаны дараа нүүр хуудаснаас машин хүснэ. Менежер машин оноож өгнө.",
  ["<i>Машин хүсэх</i> дарна", "Машин оноогдмогц <i>Хүлээлцэх акт</i>-аа шалгаж гарын үсэг зурна"],
  "Акт дээр машины <b>гэмтэл, дутуу</b> зүйлийг заавал шалгаарай.",
  '<div class="ab nob">Сайн байна уу, Бат</div><div class="card">Миний машин<small>Машин хуваарилагдаагүй</small></div><div class="lb" style="margin:6px 0 0">Хурдан үйлдлүүд</div>'
  '<div class="qa"><div class="hl">Машин хүсэх<span class="tap" style="right:-14px;bottom:-14px"></span></div><div>Ажлын зар</div><div>Түлш авсан</div><div>Баримт бичиг</div></div>'
  '<div class="card" style="margin-top:auto"><small>Дараа нь</small>Авто машины хүлээлцэх акт</div>' + b("Хүлээлцэх акт баталгаажуулах", g=True)),
 stepcard(6, 5, "Ээлж эхлүүлэх",
  "Машин цэсэнд орж чиглэл, <strong>эхлэлтийн КМ</strong> заалтаа оруулна.",
  ["Чиглэл: Хаанаас → Хаашаа", "<i>Машиныг шалгасан, бэлэн байна</i> чагтална", "<i>Ээлж эхлүүлэх</i> дарна"],
  "Машинаа <b>шалгаагүй</b> бол ээлж эхлэхгүй.",
  '<div class="ab">Ээлж эхлүүлэх</div><div class="card">78-21 УНА · Чиргүүлтэй<small>Өглөө ээлж</small></div>'
  '<div class="lb">Чиглэл</div><div class="in v">Таван толгой → Цагаан хад</div><div class="lb">Эхлэлтийн КМ заалт</div><div class="in v">184 520</div>'
  '<div class="chk" style="margin-top:8px">Машиныг шалгасан, бэлэн байна</div><div style="margin-top:auto">' + b("Ээлж эхлүүлэх", True) + '</div>'),
 stepcard(7, 6, "Даалгавар гүйцэтгэх",
  "Диспетчер даалгавар оноомогц <strong>Миний даалгавар</strong>-т гарна.",
  ["Ачаа авахдаа <i>Эхлүүлэх</i> дарна", "Хүргээд <i>Хүргэлтийн баталгаа (POD)</i>: зураг, нэр, гарын үсэг"],
  "POD илгээсний дараа даалгавар <b>автоматаар дуусна</b>.",
  '<div class="ab">Даалгаврын дэлгэрэнгүй</div><div class="card"><span class="chip">Хуваарилагдсан</span><div style="margin-top:8px">Таван толгой → Цагаан хад</div><small>Нүүрс · Ачих цаг 08:00</small></div>'
  '<div class="map"></div><div class="card"><small>Ажлын заавар</small>Ачилтын талбай 3, жин хэмжүүр дээр зогсоно</div>'
  '<div style="margin-top:auto;display:flex;flex-direction:column;gap:12px">' + b("Эхлүүлэх", True) + b("Хүргэлтийн баталгаа (POD)", g=True) + '</div>'),
 stepcard(8, 7, "Түлш авсан",
  "Түлш авах бүртээ шууд бүртгэнэ. <strong>Баримтын зураг</strong> заавал.",
  ["Нүүр хуудсанд <i>Түлш авсан</i> дарна", "Литр, одометр, ШТС-ийн нэрээ бичнэ", "<i>Зураг авах</i>, тэгээд <i>Бүртгэл илгээх</i>"],
  "Баримт нь машины <b>GPS түлшний мэдрэгчтэй</b> тулгагдана.",
  '<div class="ab">Түлш авсан</div><div class="card">78-21 УНА<small>184 760 км</small></div>'
  '<div class="row"><div><div class="lb">Нэмсэн литр</div><div class="in v" style="margin-top:12px">320 л</div></div><div><div class="lb">Одометр</div><div class="in v" style="margin-top:12px">184 760</div></div></div>'
  '<div class="lb">ШТС-ийн нэр</div><div class="in v">Цогтцэций ШТС</div><div class="lb">Баримтын зураг</div>'
  '<div class="in" style="height:96px;line-height:96px;text-align:center;border-style:dashed">Зураг авах</div><div style="margin-top:auto">' + b("Бүртгэл илгээх", True) + '</div>'),
 stepcard(9, 8, "Асуудал, ажлаа дуусгах",
  "Замд эвдрэл гарвал машин цэснээс <strong>зурагтай</strong> мэдээлнэ.",
  ["<i>Асуудал</i>: төрөл, тайлбар, зураг", "Ээлжийн төгсгөлд <i>Ажлыг дуусгах</i>: КМ-ээ оруулж машинаа хүлээлгэн өгнө"],
  "Засвар дуусаагүй бол <b>менежерт автоматаар</b> мэдэгдэнэ.",
  '<div class="ab nob">Миний машин</div><div class="card"><span class="chip" style="background:#DDF5E6;color:#1c7a45">Аялал идэвхтэй</span><div style="margin-top:8px">78-21 УНА</div><small>Таван толгой → Цагаан хад · GPS холбогдсон</small></div>'
  '<div class="map" style="height:200px"></div><div class="row" style="margin-top:auto">' + b("Асуудал", g=True) + '</div>' + b("Ажлыг дуусгах", True)),
 page(10, """<h1 style="margin-top:60px">Асуух зүйл<br>байна уу?<br><em>Залга.</em></h1>
 <div style="font:900 128px Onest;margin-top:50px;color:var(--hivis)">8008 5792</div>
 <p style="font:700 36px/1.45 Manrope;color:#c9cdd2;margin-top:30px">Компанийн код, бүртгэл, апп-тай холбоотой бүх асуултад туслана.</p>
 <div class="tip" style="display:flex;align-items:center;gap:26px;font-size:34px"><img src="icon.png" style="width:110px;border-radius:24px"><div><b>Open Teever</b><br>App Store · Google Play</div></div>""", kicker="Хадгалаад хуваалцаарай"),
]
for i, h in enumerate(cards, 1):
    f = S / f"guide3-{i}.html"; f.write_text(h, encoding="utf-8")
    subprocess.run([CH, "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", "--window-size=1080,1350", f"--screenshot={OUT}/open-teever-guide-{i:02d}.png", "--virtual-time-budget=3000", f.as_uri()], check=True, capture_output=True)
print("ok")
