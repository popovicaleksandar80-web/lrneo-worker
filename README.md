# LR Neo automatic worker

Ovaj worker radi ono sto Loopia shared hosting ne moze:

1. pokrene Chrome/Chromium u pozadini,
2. uloguje se u LR Neo,
3. otvori `https://neo.lrworld.com/a-line`,
4. procita vidljive redove tabele,
5. posalje snapshot u `api.php` na sajtu.

## Sta ide na Loopia

Na Loopia hosting kopiraj ove izmenjene fajlove iz glavnog projekta:

- `api.php`
- `app-config.php`
- `statistika.html`
- `sr/statistika.html`
- `js/statistika.js`
- `css/statistika.css`

U `app-config.php` promeni:

```php
define('LRNEO_INGEST_TOKEN', 'neki-dugacak-tajni-token');
```

Isti token mora biti u worker varijabli `LR_APP_INGEST_TOKEN`.

## Sta ide na worker server

Folder `lrneo-worker` ide na server koji podrzava Node + Playwright + Chromium.

Potrebne komande:

```bash
npm install
npm run install-browser
```

Environment variables:

```bash
LRNEO_EMAIL="tvoj LR Neo login"
LRNEO_PASSWORD="tvoja LR Neo lozinka"
LR_APP_INGEST_URL="https://tvoj-domen.com/api.php"
LR_APP_INGEST_TOKEN="isti-token-iz-app-config.php"
LR_APP_USERNAME="admin"
LRNEO_HEADLESS="true"
```

`LR_APP_USERNAME` je username korisnika u tvojoj aplikaciji kome se snapshot snima.

Rucni test:

```bash
npm run run
```

Ako je sve dobro, worker ispisuje `ok: true`, a `statistika.html` prikazuje novi snapshot.

## Automatski svaki dan

Na VPS-u dodaj cron, primer svaki dan u 06:30:

```cron
30 6 * * * cd /putanja/lrneo-worker && /usr/bin/npm run run >> worker.log 2>&1
```

Ako koristis Render/Railway/Fly.io, napravi scheduled/cron job koji pokrece:

```bash
npm run run
```
