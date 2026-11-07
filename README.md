# OBLICZE — GitHub Pages

Mobilne studio podmiany twarzy: jedna twarz albo kilka (od lewej do prawej).
Same pliki statyczne. Ciężka praca idzie do darmowego Space na Hugging Face.

## Pliki

- `index.html` — interfejs (Tailwind CSS z CDN)
- `script.js` — obsługa zdjęć, pasek postępu, pobieranie
- `engine.js` — `fetch` do API i składanie wielu twarzy

## 1. Token

1. Załóż konto na [huggingface.co](https://huggingface.co).
2. Wejdź w [Settings → Access Tokens](https://huggingface.co/settings/tokens) i utwórz token z uprawnieniem **Read**.
3. **Nie wklejaj tokenu do publicznego repozytorium.** Wpisz go w aplikacji w polu „Klucz API” — zostanie tylko w przeglądarce (`localStorage`).

Opcjonalnie, jeśli repozytorium jest prywatne, możesz wkleić token na górze `engine.js`:

```js
export const HF_TOKEN = "hf_twoj_token";
```

Publiczne Space `tonyassi/face-swap` działa też bez tokenu, ale kolejka jest wolniejsza i łatwiej o limit.

## 2. Wrzucenie na GitHub Pages

1. Utwórz puste repozytorium (np. `oblicze`).
2. Wrzuć do niego **trzy pliki**: `index.html`, `script.js`, `engine.js` — w katalogu głównym, nie w podfolderze.
3. Settings → Pages → Build and deployment → **Deploy from a branch**.
4. Branch: `main`, folder: `/ (root)`.
5. Po minucie strona jest pod `https://TWOJ-LOGIN.github.io/oblicze/`.

Nie ustawiaj Jekyll. Jeśli GitHub go włączy, dodaj pusty plik `.nojekyll`.

## 3. Jak używać

1. Wybierz **Jedna twarz**, **Wiele twarzy** albo **Zamiana głowy**.
2. Wgraj jedno zdjęcie źródłowe i jedno docelowe. W trybie wielu twarzy aplikacja sama wykryje twarze i pokaże miniaturki. Dotknij twarz na źródle, potem osobę na celu. Pary od lewej są ustawione z góry.
3. **Zamiana głowy** wysyła do API parametr `expand_ratio` (suwak „Zasięg głowy”) i wtapia całą głowę ze włosami, uszami i szyją — nie same rysy.
4. Zaznacz zgodę osób ze zdjęć.
5. Uruchom podmianę. Pierwsze wywołanie darmowego Space potrafi trwać około minuty.
6. **Pobierz na telefon**.

Pary ustawiasz palcem: numer na kwadracie celu to numer twarzy ze źródła. Nie dodajesz osobnych plików dla każdej twarzy.
Reszta zdjęcia zostaje w oryginalnej rozdzielczości (dłuższy bok maksymalnie 2560 px).
Zamiana głowy korzysta ze Space `kailashjha123/head-swap-tool` i parametru `expand_ratio`.

## 4. Własny model

W polu „Space Hugging Face” albo w `engine.js`:

```js
hfSpaceId: "uzytkownik/nazwa-space",
hfApiName: "swap_faces",
```

Endpoint musi przyjmować dwa obrazy (źródło, cel) i oddawać obraz. Domyślny to
[tonyassi/face-swap](https://huggingface.co/spaces/tonyassi/face-swap), funkcja `swap_faces`.

Replicate (`codeplugtech/face-swap`) jest wpisany w `engine.js`, ale **przeglądarka blokuje CORS**
na `api.replicate.com`. Bez własnego proxy zostań przy Hugging Face.

## 5. Zgoda

Podmieniaj tylko twarze osób, które się na to godzą. Nie używaj wyniku do podszywania się,
nękania ani treści intymnych bez zgody.
