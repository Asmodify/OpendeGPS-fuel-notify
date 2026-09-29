# Facebook автомат пост

Open Development-ийн Facebook хуудас (id `61593781929270`) руу `posts.json` дахь постуудыг
цагт нь автоматаар нийтэлдэг. GitHub Actions Даваа, Лхагва, Баасан гарагт Улаанбаатарын
цагаар 10:00-д ажиллаж, хугацаа нь болсон, **зөвшөөрөгдсөн** постыг нэг удаад нэгийг нийтэлнэ.

## Пост нэмэх, засах

`posts.json` дотор пост бүр:

| Талбар | Утга |
|---|---|
| `id` | давтагдахгүй нэр, жишээ нь `2026-11-02-safety` |
| `publish_at` | Улаанбаатарын цагаар `YYYY-MM-DD HH:MM` |
| `title` | зөвхөн дотоод хэрэгцээнд |
| `text` | постын бичвэр (`\n` = шинэ мөр) |
| `approved` | `true` болгосон постыг л нийтэлнэ |
| `hashtags` | заавал биш; байхгүй бол `default_hashtags` орно |
| `image` | заавал биш; `images/файл.jpg` эсвэл `https://...` зургийн холбоос |
| `link` | заавал биш; зураггүй пост дээр холбоос хавсаргана |

| `series` | цувралын нэр, зургийн дээд талд гарна |
| `card` | зургийн том гарчиг (`headline`) ба 3 мөр (`lines`) |

Утасны дугаарыг `posts.json`-ийн `contact.phone`-д (WeChat бол `contact.wechat`) нэг удаа бичнэ;
бичвэр дэх `{phone}` автоматаар солигдоно. `[[...]]` гэсэн бөглөх хэсэгтэй эсвэл утас
тохируулаагүй постыг зөвшөөрсөн ч нийтлэхгүй, `list` дээр `blocked` гэж харагдана.

## Зураг (карт)

Пост бүрд 1080x1080 брэндийн зураг `cards/`-д байна. Бичвэр, утас өөрчлөгдвөл дахин үүсгэнэ:

```bash
python facebook/cards/make_cards.py              # бүгд
python facebook/cards/make_cards.py 2026-10-07-drivers
```

chrome-headless-shell хэрэгтэй (`npx @puppeteer/browsers install chrome-headless-shell`,
дараа нь `CHROME=<зам>`). Фонтууд (Onest, Manrope, OFL лиценз) `cards/fonts/`-д бий.

Нийтлэгдсэн постод `posted_id`, `posted_at` автоматаар бичигдэнэ; тэр постыг дахин нийтлэхгүй.

## Нэг удаагийн тохиргоо

1. **Page access token авах.** https://developers.facebook.com дээр Business төрлийн апп
   үүсгээд Graph API Explorer-оос `pages_manage_posts`, `pages_read_engagement`
   зөвшөөрөлтэй User token аваад, урт хугацааны token болгож, `GET /me/accounts`-оос тухайн
   хуудасны `access_token`-ийг хуулна (урт хугацааны user token-оос авсан Page token дуусдаггүй).
2. **GitHub-д хадгалах.** Repo → Settings → Secrets and variables → Actions:
   - Secret `FB_PAGE_TOKEN` = дээрх Page token
   - Secret `FB_PAGE_ID` = хуудасны id (заавал биш, `posts.json`-д байгаа)
   - Variable `FB_LIVE` = `true` (үүнийг тавихаас нааш зөвхөн туршилтаар ажиллана)
3. Энэ салбарыг `main` руу нэгтгэнэ (хуваарьт ажил зөвхөн үндсэн салбар дээр ажилладаг).

## Гараар ажиллуулах

```bash
python facebook/fb_poster.py list                # аль пост ямар төлөвтэй
python facebook/fb_poster.py preview             # preview.html үүсгэнэ
FB_PAGE_TOKEN=... python facebook/fb_poster.py check      # token шалгах
FB_PAGE_TOKEN=... python facebook/fb_poster.py run        # туршилт, юу ч нийтлэхгүй
FB_PAGE_TOKEN=... python facebook/fb_poster.py run --live # үнэхээр нийтэлнэ
python -m unittest facebook/test_fb_poster.py    # тест
```

Зөвхөн Python 3 стандарт сан ашигладаг, нэмэлт суулгах зүйлгүй.
