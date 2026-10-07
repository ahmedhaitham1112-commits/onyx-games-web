update public.games
set download_url_pc = 'https://github.com/ahmedhaitham1112-commits/-onyx-games-releases/releases/download/v1.0.0/StareAtAGuySimulator-Setup.exe'
where slug = 'stare-at-a-guy-simulator'
returning slug, name, download_url_pc;