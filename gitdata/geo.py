"""Offline-Geocoder fuer GitHubs Freitext-`location`.

GitHub-Profile tragen den Ort als ungeprueften Freitext ("San Francisco, CA",
"Berlin, Germany", "北京", "🇧🇷 São Paulo"). Fuer die Weltansicht brauchen wir
daraus (Land, Stadt, lat, lon) — ohne Netzabhaengigkeit und ohne dicke
Geocoding-Bibliothek. Ansatz: kuratierte Tabellen (Laender + Tech-Hub-Staedte +
Aliasse), Freitext zerlegen und von rechts (Land steht meist zuletzt) matchen.

Bewusst kein vollstaendiges Gazetteer: die ~200 Staedte + ~100 Laender decken
den Grossteil der GitHub-Nutzer ab. Unbekanntes -> None (kein Rateraten).

ponytail: Wortlisten-Matcher statt echtem Geocoder. Ceiling: seltene/kleine Orte
fallen durch. Upgrade-Pfad: geonames-Dump laden, wenn Abdeckung zu duenn wird.
"""
from __future__ import annotations

import re

# Land -> (lat, lon, ISO2). Zentroide grob (Landesmitte), reichen fuer Bubbles.
COUNTRIES: dict[str, tuple[float, float, str]] = {
    "United States": (39.8, -98.6, "US"), "United Kingdom": (54.0, -2.0, "GB"),
    "Canada": (56.1, -106.3, "CA"), "Germany": (51.2, 10.4, "DE"),
    "France": (46.2, 2.2, "FR"), "Spain": (40.0, -3.7, "ES"),
    "Portugal": (39.6, -8.0, "PT"), "Italy": (41.9, 12.6, "IT"),
    "Netherlands": (52.1, 5.3, "NL"), "Belgium": (50.6, 4.7, "BE"),
    "Switzerland": (46.8, 8.2, "CH"), "Austria": (47.6, 14.1, "AT"),
    "Ireland": (53.4, -8.2, "IE"), "Denmark": (56.3, 9.5, "DK"),
    "Sweden": (60.1, 18.6, "SE"), "Norway": (60.5, 8.5, "NO"),
    "Finland": (61.9, 25.7, "FI"), "Iceland": (64.9, -19.0, "IS"),
    "Poland": (51.9, 19.1, "PL"), "Czechia": (49.8, 15.5, "CZ"),
    "Slovakia": (48.7, 19.7, "SK"), "Hungary": (47.2, 19.5, "HU"),
    "Romania": (45.9, 25.0, "RO"), "Bulgaria": (42.7, 25.5, "BG"),
    "Greece": (39.1, 21.8, "GR"), "Ukraine": (48.4, 31.2, "UA"),
    "Belarus": (53.7, 27.9, "BY"), "Russia": (61.5, 105.3, "RU"),
    "Estonia": (58.6, 25.0, "EE"), "Latvia": (56.9, 24.6, "LV"),
    "Lithuania": (55.2, 23.9, "LT"), "Serbia": (44.0, 21.0, "RS"),
    "Croatia": (45.1, 15.2, "HR"), "Slovenia": (46.2, 15.0, "SI"),
    "Turkey": (39.0, 35.2, "TR"), "Israel": (31.5, 34.8, "IL"),
    "Iran": (32.4, 53.7, "IR"), "Saudi Arabia": (23.9, 45.1, "SA"),
    "United Arab Emirates": (23.4, 53.8, "AE"), "Egypt": (26.8, 30.8, "EG"),
    "Nigeria": (9.1, 8.7, "NG"), "Kenya": (0.0, 37.9, "KE"),
    "Ghana": (7.9, -1.0, "GH"), "South Africa": (-30.6, 22.9, "ZA"),
    "Morocco": (31.8, -7.1, "MA"), "Tunisia": (33.9, 9.6, "TN"),
    "Algeria": (28.0, 1.7, "DZ"), "Ethiopia": (9.1, 40.5, "ET"),
    "China": (35.9, 104.2, "CN"), "Japan": (36.2, 138.3, "JP"),
    "South Korea": (35.9, 127.8, "KR"), "Taiwan": (23.7, 121.0, "TW"),
    "Hong Kong": (22.3, 114.2, "HK"), "Singapore": (1.35, 103.8, "SG"),
    "India": (22.0, 79.0, "IN"), "Pakistan": (30.4, 69.3, "PK"),
    "Bangladesh": (23.7, 90.4, "BD"), "Sri Lanka": (7.9, 80.8, "LK"),
    "Nepal": (28.4, 84.1, "NP"), "Indonesia": (-2.5, 118.0, "ID"),
    "Malaysia": (4.2, 101.9, "MY"), "Thailand": (15.9, 100.9, "TH"),
    "Vietnam": (14.1, 108.3, "VN"), "Philippines": (12.9, 121.8, "PH"),
    "Australia": (-25.3, 133.8, "AU"), "New Zealand": (-41.0, 174.9, "NZ"),
    "Brazil": (-14.2, -51.9, "BR"), "Argentina": (-38.4, -63.6, "AR"),
    "Chile": (-35.7, -71.5, "CL"), "Colombia": (4.6, -74.3, "CO"),
    "Peru": (-9.2, -75.0, "PE"), "Mexico": (23.6, -102.5, "MX"),
    "Venezuela": (6.4, -66.6, "VE"), "Uruguay": (-32.5, -55.8, "UY"),
    "Ecuador": (-1.8, -78.2, "EC"), "Bolivia": (-16.3, -63.6, "BO"),
    "Costa Rica": (9.7, -83.8, "CR"), "Cuba": (21.5, -77.8, "CU"),
    "Kazakhstan": (48.0, 66.9, "KZ"), "Georgia (country)": (42.3, 43.4, "GE"),
    "Armenia": (40.1, 45.0, "AM"), "Azerbaijan": (40.1, 47.6, "AZ"),
}

# Alias (lowercase) -> kanonischer Landesname. Deckt Umgangssprache, Landessprache,
# historische/Teil-Namen und Flaggen-Emoji ab.
ALIASES: dict[str, str] = {
    "usa": "United States", "u.s.a": "United States", "u.s.a.": "United States",
    "us": "United States", "u.s.": "United States", "america": "United States",
    "united states of america": "United States", "estados unidos": "United States",
    "uk": "United Kingdom", "u.k.": "United Kingdom", "england": "United Kingdom",
    "scotland": "United Kingdom", "wales": "United Kingdom", "britain": "United Kingdom",
    "great britain": "United Kingdom", "northern ireland": "United Kingdom",
    "deutschland": "Germany", "brasil": "Brazil", "españa": "Spain", "espana": "Spain",
    "россия": "Russia", "rossiya": "Russia", "中国": "China", "中國": "China",
    "prc": "China", "p.r.china": "China", "mainland china": "China",
    "日本": "Japan", "nippon": "Japan", "한국": "South Korea", "korea": "South Korea",
    "republic of korea": "South Korea", "台灣": "Taiwan", "台湾": "Taiwan",
    "roc": "Taiwan", "香港": "Hong Kong", "भारत": "India", "bharat": "India",
    "türkiye": "Turkey", "turkiye": "Turkey", "türkei": "Turkey",
    "the netherlands": "Netherlands", "holland": "Netherlands", "nederland": "Netherlands",
    "italia": "Italy", "österreich": "Austria", "oesterreich": "Austria",
    "schweiz": "Switzerland", "suisse": "Switzerland", "svizzera": "Switzerland",
    "sverige": "Sweden", "norge": "Norway", "suomi": "Finland", "danmark": "Denmark",
    "polska": "Poland", "czech republic": "Czechia", "česko": "Czechia",
    "uae": "United Arab Emirates", "u.a.e.": "United Arab Emirates",
    "россия́": "Russia", "rus": "Russia", "南非": "South Africa", "rsa": "South Africa",
    "méxico": "Mexico", "мексика": "Mexico", "viet nam": "Vietnam", "việt nam": "Vietnam",
    "prc china": "China", "hk": "Hong Kong", "sg": "Singapore", "nz": "New Zealand",
    "🇺🇸": "United States", "🇬🇧": "United Kingdom", "🇩🇪": "Germany", "🇫🇷": "France",
    "🇨🇳": "China", "🇯🇵": "Japan", "🇮🇳": "India", "🇧🇷": "Brazil", "🇷🇺": "Russia",
    "🇨🇦": "Canada", "🇦🇺": "Australia", "🇪🇸": "Spain", "🇮🇹": "Italy", "🇳🇱": "Netherlands",
    "🇸🇪": "Sweden", "🇵🇱": "Poland", "🇺🇦": "Ukraine", "🇰🇷": "South Korea", "🇹🇼": "Taiwan",
    "🇮🇱": "Israel", "🇨🇭": "Switzerland", "🇸🇬": "Singapore", "🇮🇷": "Iran", "🇲🇽": "Mexico",
    "🇹🇷": "Turkey", "🇳🇬": "Nigeria", "🇮🇩": "Indonesia", "🇵🇹": "Portugal", "🇮🇪": "Ireland",
    "🇦🇷": "Argentina", "🇧🇪": "Belgium", "🇦🇹": "Austria", "🇳🇴": "Norway", "🇩🇰": "Denmark",
    "🇫🇮": "Finland", "🇨🇿": "Czechia", "🇬🇷": "Greece", "🇭🇰": "Hong Kong", "🇳🇿": "New Zealand",
}

# Stadt (lowercase) -> (Land, lat, lon). Fokus auf Tech-Hubs + Grossstaedte.
CITIES: dict[str, tuple[str, float, float]] = {
    # US
    "san francisco": ("United States", 37.77, -122.42), "sf": ("United States", 37.77, -122.42),
    "bay area": ("United States", 37.6, -122.2), "silicon valley": ("United States", 37.4, -122.1),
    "san jose": ("United States", 37.34, -121.89), "mountain view": ("United States", 37.39, -122.08),
    "palo alto": ("United States", 37.44, -122.14), "oakland": ("United States", 37.80, -122.27),
    "los angeles": ("United States", 34.05, -118.24), "la": ("United States", 34.05, -118.24),
    "san diego": ("United States", 32.72, -117.16), "seattle": ("United States", 47.61, -122.33),
    "portland": ("United States", 45.52, -122.68), "new york": ("United States", 40.71, -74.01),
    "nyc": ("United States", 40.71, -74.01), "new york city": ("United States", 40.71, -74.01),
    "brooklyn": ("United States", 40.68, -73.94), "boston": ("United States", 42.36, -71.06),
    "cambridge": ("United States", 42.37, -71.11), "chicago": ("United States", 41.88, -87.63),
    "austin": ("United States", 30.27, -97.74), "dallas": ("United States", 32.78, -96.80),
    "houston": ("United States", 29.76, -95.37), "denver": ("United States", 39.74, -104.99),
    "atlanta": ("United States", 33.75, -84.39), "miami": ("United States", 25.76, -80.19),
    "washington": ("United States", 38.90, -77.04), "washington dc": ("United States", 38.90, -77.04),
    "pittsburgh": ("United States", 40.44, -79.99), "detroit": ("United States", 42.33, -83.05),
    "philadelphia": ("United States", 39.95, -75.16), "phoenix": ("United States", 33.45, -112.07),
    "minneapolis": ("United States", 44.98, -93.27), "salt lake city": ("United States", 40.76, -111.89),
    "raleigh": ("United States", 35.78, -78.64), "nashville": ("United States", 36.16, -86.78),
    # Canada
    "toronto": ("Canada", 43.65, -79.38), "vancouver": ("Canada", 49.28, -123.12),
    "montreal": ("Canada", 45.50, -73.57), "ottawa": ("Canada", 45.42, -75.70),
    "waterloo": ("Canada", 43.46, -80.52), "calgary": ("Canada", 51.05, -114.07),
    "edmonton": ("Canada", 53.55, -113.49),
    # UK / Ireland
    "london": ("United Kingdom", 51.51, -0.13), "manchester": ("United Kingdom", 53.48, -2.24),
    "birmingham": ("United Kingdom", 52.49, -1.89), "edinburgh": ("United Kingdom", 55.95, -3.19),
    "glasgow": ("United Kingdom", 55.86, -4.25), "bristol": ("United Kingdom", 51.45, -2.59),
    "cambridge uk": ("United Kingdom", 52.21, 0.12), "oxford": ("United Kingdom", 51.75, -1.26),
    "leeds": ("United Kingdom", 53.80, -1.55), "dublin": ("Ireland", 53.35, -6.26),
    "cork": ("Ireland", 51.90, -8.47),
    # DACH
    "berlin": ("Germany", 52.52, 13.40), "munich": ("Germany", 48.14, 11.58),
    "münchen": ("Germany", 48.14, 11.58), "hamburg": ("Germany", 53.55, 9.99),
    "frankfurt": ("Germany", 50.11, 8.68), "cologne": ("Germany", 50.94, 6.96),
    "köln": ("Germany", 50.94, 6.96), "stuttgart": ("Germany", 48.78, 9.18),
    "düsseldorf": ("Germany", 51.23, 6.78), "leipzig": ("Germany", 51.34, 12.37),
    "dresden": ("Germany", 51.05, 13.74), "karlsruhe": ("Germany", 49.01, 8.40),
    "vienna": ("Austria", 48.21, 16.37), "wien": ("Austria", 48.21, 16.37),
    "zurich": ("Switzerland", 47.37, 8.54), "zürich": ("Switzerland", 47.37, 8.54),
    "geneva": ("Switzerland", 46.20, 6.14), "bern": ("Switzerland", 46.95, 7.45),
    "basel": ("Switzerland", 47.56, 7.59), "lausanne": ("Switzerland", 46.52, 6.63),
    # Nordics
    "stockholm": ("Sweden", 59.33, 18.06), "gothenburg": ("Sweden", 57.71, 11.97),
    "oslo": ("Norway", 59.91, 10.75), "copenhagen": ("Denmark", 55.68, 12.57),
    "helsinki": ("Finland", 60.17, 24.94), "reykjavik": ("Iceland", 64.15, -21.94),
    "malmö": ("Sweden", 55.60, 13.00),
    # West/South EU
    "paris": ("France", 48.86, 2.35), "lyon": ("France", 45.76, 4.84),
    "toulouse": ("France", 43.60, 1.44), "nantes": ("France", 47.22, -1.55),
    "bordeaux": ("France", 44.84, -0.58), "lille": ("France", 50.63, 3.06),
    "marseille": ("France", 43.30, 5.37), "grenoble": ("France", 45.19, 5.72),
    "amsterdam": ("Netherlands", 52.37, 4.90), "rotterdam": ("Netherlands", 51.92, 4.48),
    "utrecht": ("Netherlands", 52.09, 5.12), "eindhoven": ("Netherlands", 51.44, 5.48),
    "brussels": ("Belgium", 50.85, 4.35), "ghent": ("Belgium", 51.05, 3.72),
    "antwerp": ("Belgium", 51.22, 4.40), "madrid": ("Spain", 40.42, -3.70),
    "barcelona": ("Spain", 41.39, 2.16), "valencia": ("Spain", 39.47, -0.38),
    "seville": ("Spain", 37.39, -5.98), "málaga": ("Spain", 36.72, -4.42),
    "lisbon": ("Portugal", 38.72, -9.14), "lisboa": ("Portugal", 38.72, -9.14),
    "porto": ("Portugal", 41.15, -8.61), "rome": ("Italy", 41.90, 12.50),
    "milan": ("Italy", 45.46, 9.19), "milano": ("Italy", 45.46, 9.19),
    "turin": ("Italy", 45.07, 7.69), "bologna": ("Italy", 44.49, 11.34),
    "naples": ("Italy", 40.85, 14.27), "florence": ("Italy", 43.77, 11.26),
    "athens": ("Greece", 37.98, 23.73), "thessaloniki": ("Greece", 40.64, 22.94),
    # Central/East EU
    "warsaw": ("Poland", 52.23, 21.01), "kraków": ("Poland", 50.06, 19.94),
    "krakow": ("Poland", 50.06, 19.94), "wrocław": ("Poland", 51.11, 17.03),
    "wroclaw": ("Poland", 51.11, 17.03), "poznań": ("Poland", 52.41, 16.93),
    "gdańsk": ("Poland", 54.35, 18.65), "prague": ("Czechia", 50.08, 14.44),
    "praha": ("Czechia", 50.08, 14.44), "brno": ("Czechia", 49.20, 16.61),
    "budapest": ("Hungary", 47.50, 19.04), "bratislava": ("Slovakia", 48.15, 17.11),
    "bucharest": ("Romania", 44.43, 26.10), "cluj": ("Romania", 46.77, 23.60),
    "cluj-napoca": ("Romania", 46.77, 23.60), "iași": ("Romania", 47.16, 27.59),
    "sofia": ("Bulgaria", 42.70, 23.32), "belgrade": ("Serbia", 44.79, 20.45),
    "zagreb": ("Croatia", 45.81, 15.98), "ljubljana": ("Slovenia", 46.06, 14.51),
    "kyiv": ("Ukraine", 50.45, 30.52), "kiev": ("Ukraine", 50.45, 30.52),
    "kharkiv": ("Ukraine", 49.99, 36.23), "lviv": ("Ukraine", 49.84, 24.03),
    "minsk": ("Belarus", 53.90, 27.57), "tallinn": ("Estonia", 59.44, 24.75),
    "riga": ("Latvia", 56.95, 24.11), "vilnius": ("Lithuania", 54.69, 25.28),
    "moscow": ("Russia", 55.76, 37.62), "москва": ("Russia", 55.76, 37.62),
    "saint petersburg": ("Russia", 59.94, 30.31), "st petersburg": ("Russia", 59.94, 30.31),
    "novosibirsk": ("Russia", 55.01, 82.93), "yekaterinburg": ("Russia", 56.84, 60.61),
    # Middle East
    "istanbul": ("Turkey", 41.01, 28.98), "ankara": ("Turkey", 39.93, 32.86),
    "izmir": ("Turkey", 38.42, 27.14), "tel aviv": ("Israel", 32.08, 34.78),
    "jerusalem": ("Israel", 31.77, 35.22), "haifa": ("Israel", 32.79, 34.99),
    "tehran": ("Iran", 35.69, 51.39), "dubai": ("United Arab Emirates", 25.20, 55.27),
    "abu dhabi": ("United Arab Emirates", 24.45, 54.38), "riyadh": ("Saudi Arabia", 24.71, 46.68),
    "cairo": ("Egypt", 30.04, 31.24),
    # Africa
    "lagos": ("Nigeria", 6.52, 3.38), "abuja": ("Nigeria", 9.06, 7.50),
    "nairobi": ("Kenya", -1.29, 36.82), "accra": ("Ghana", 5.60, -0.19),
    "cape town": ("South Africa", -33.92, 18.42), "johannesburg": ("South Africa", -26.20, 28.05),
    "casablanca": ("Morocco", 33.57, -7.59), "tunis": ("Tunisia", 36.81, 10.18),
    "addis ababa": ("Ethiopia", 9.03, 38.74),
    # East/South Asia
    "beijing": ("China", 39.90, 116.41), "北京": ("China", 39.90, 116.41),
    "shanghai": ("China", 31.23, 121.47), "上海": ("China", 31.23, 121.47),
    "shenzhen": ("China", 22.54, 114.06), "深圳": ("China", 22.54, 114.06),
    "guangzhou": ("China", 23.13, 113.26), "hangzhou": ("China", 30.27, 120.15),
    "chengdu": ("China", 30.57, 104.07), "wuhan": ("China", 30.59, 114.31),
    "nanjing": ("China", 32.06, 118.80), "xi'an": ("China", 34.34, 108.94),
    "tokyo": ("Japan", 35.68, 139.69), "東京": ("Japan", 35.68, 139.69),
    "osaka": ("Japan", 34.69, 135.50), "kyoto": ("Japan", 35.01, 135.77),
    "fukuoka": ("Japan", 33.59, 130.40), "yokohama": ("Japan", 35.44, 139.64),
    "seoul": ("South Korea", 37.57, 126.98), "서울": ("South Korea", 37.57, 126.98),
    "busan": ("South Korea", 35.18, 129.08), "taipei": ("Taiwan", 25.03, 121.57),
    "台北": ("Taiwan", 25.03, 121.57), "hsinchu": ("Taiwan", 24.80, 120.97),
    "hong kong": ("Hong Kong", 22.32, 114.17), "singapore": ("Singapore", 1.35, 103.82),
    "bangalore": ("India", 12.97, 77.59), "bengaluru": ("India", 12.97, 77.59),
    "mumbai": ("India", 19.08, 72.88), "delhi": ("India", 28.61, 77.21),
    "new delhi": ("India", 28.61, 77.21), "hyderabad": ("India", 17.39, 78.49),
    "chennai": ("India", 13.08, 80.27), "pune": ("India", 18.52, 73.86),
    "kolkata": ("India", 22.57, 88.36), "ahmedabad": ("India", 23.03, 72.58),
    "gurgaon": ("India", 28.46, 77.03), "noida": ("India", 28.54, 77.39),
    "kochi": ("India", 9.93, 76.27), "lahore": ("Pakistan", 31.55, 74.34),
    "karachi": ("Pakistan", 24.86, 67.01), "islamabad": ("Pakistan", 33.68, 73.05),
    "dhaka": ("Bangladesh", 23.81, 90.41), "colombo": ("Sri Lanka", 6.93, 79.85),
    "kathmandu": ("Nepal", 27.72, 85.32), "jakarta": ("Indonesia", -6.21, 106.85),
    "bandung": ("Indonesia", -6.92, 107.61), "kuala lumpur": ("Malaysia", 3.14, 101.69),
    "bangkok": ("Thailand", 13.76, 100.50), "hanoi": ("Vietnam", 21.03, 105.85),
    "ho chi minh city": ("Vietnam", 10.82, 106.63), "saigon": ("Vietnam", 10.82, 106.63),
    "manila": ("Philippines", 14.60, 120.98), "cebu": ("Philippines", 10.32, 123.89),
    # Oceania
    "sydney": ("Australia", -33.87, 151.21), "melbourne": ("Australia", -37.81, 144.96),
    "brisbane": ("Australia", -27.47, 153.03), "perth": ("Australia", -31.95, 115.86),
    "canberra": ("Australia", -35.28, 149.13), "adelaide": ("Australia", -34.93, 138.60),
    "auckland": ("New Zealand", -36.85, 174.76), "wellington": ("New Zealand", -41.29, 174.78),
    # Latin America
    "são paulo": ("Brazil", -23.55, -46.63), "sao paulo": ("Brazil", -23.55, -46.63),
    "rio de janeiro": ("Brazil", -22.91, -43.17), "belo horizonte": ("Brazil", -19.92, -43.94),
    "brasília": ("Brazil", -15.79, -47.88), "curitiba": ("Brazil", -25.43, -49.27),
    "porto alegre": ("Brazil", -30.03, -51.23), "recife": ("Brazil", -8.05, -34.88),
    "florianópolis": ("Brazil", -27.60, -48.55), "buenos aires": ("Argentina", -34.60, -58.38),
    "córdoba": ("Argentina", -31.42, -64.18), "santiago": ("Chile", -33.45, -70.67),
    "bogotá": ("Colombia", 4.71, -74.07), "bogota": ("Colombia", 4.71, -74.07),
    "medellín": ("Colombia", 6.24, -75.58), "medellin": ("Colombia", 6.24, -75.58),
    "lima": ("Peru", -12.05, -77.04), "mexico city": ("Mexico", 19.43, -99.13),
    "ciudad de méxico": ("Mexico", 19.43, -99.13), "guadalajara": ("Mexico", 20.67, -103.35),
    "monterrey": ("Mexico", 25.67, -100.32), "montevideo": ("Uruguay", -34.90, -56.19),
    "quito": ("Ecuador", -0.18, -78.47), "san josé": ("Costa Rica", 9.93, -84.08),
    "havana": ("Cuba", 23.11, -82.37), "caracas": ("Venezuela", 10.48, -66.90),
    "tbilisi": ("Georgia (country)", 41.72, 44.79), "yerevan": ("Armenia", 40.18, 44.51),
    "almaty": ("Kazakhstan", 43.24, 76.89), "baku": ("Azerbaijan", 40.41, 49.87),
}

# 2-Letter US-Staaten (nach Komma: "Austin, TX"). Nur der Landeszuschlag zaehlt,
# die Stadt links davon liefert (falls bekannt) die genaue Position.
US_STATES = {
    "al", "ak", "az", "ar", "ca", "co", "ct", "de", "fl", "ga", "hi", "id", "il",
    "in", "ia", "ks", "ky", "me", "md", "ma", "mi", "mn", "ms", "mo", "mt",
    "ne", "nv", "nh", "nj", "nm", "ny", "nc", "nd", "oh", "ok", "or", "pa", "ri",
    "sc", "sd", "tn", "tx", "ut", "vt", "va", "wa", "wv", "wi", "wy", "dc",
}

# Ausgeschriebene US-Staaten ("North Carolina") -> USA. Ohne Stadt nur Landeslevel.
US_STATE_NAMES = {
    "alabama", "alaska", "arizona", "arkansas", "california", "colorado",
    "connecticut", "delaware", "florida", "georgia", "hawaii", "idaho", "illinois",
    "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine", "maryland",
    "massachusetts", "michigan", "minnesota", "mississippi", "missouri", "montana",
    "nebraska", "nevada", "new hampshire", "new jersey", "new mexico", "new york state",
    "north carolina", "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania",
    "rhode island", "south carolina", "south dakota", "tennessee", "texas", "utah",
    "vermont", "virginia", "washington state", "west virginia", "wisconsin", "wyoming",
}

_SPLIT = re.compile(r"\s*[,/|·•→\-–—]\s*|\s{2,}")
_FLAG = re.compile("[\U0001F1E6-\U0001F1FF]{2}")


def geocode(text: str | None) -> tuple[str, str | None, float, float] | None:
    """Freitext -> (Land, Stadt|None, lat, lon) oder None.

    Stadt-Treffer schlaegt Land (genauere Koordinate). Flaggen-Emoji werden als
    Land gewertet. Reihenfolge im String egal — es gewinnt der spezifischste Treffer.
    """
    if not text:
        return None
    for flag in _FLAG.findall(text):
        if flag in ALIASES:
            country = ALIASES[flag]
            lat, lon, _ = COUNTRIES[country]
            # Praeziser, falls zusaetzlich eine (passende) Stadt genannt ist.
            hit = _find_city(text)
            if hit and hit[1] == country:
                key, _c, clat, clon = hit
                return (country, _display(text, key), clat, clon)
            return (country, None, lat, lon)

    hit = _find_city(text)          # (key, country, lat, lon) | None
    country_hit = _find_country(text)
    if hit:
        key, ccountry, lat, lon = hit
        # Explizit genanntes, widersprechendes Land respektieren, wenn der
        # Stadtname mehrdeutig ist (z.B. "Cambridge, UK" != Cambridge MA).
        if country_hit and country_hit != ccountry and key in _AMBIG:
            clat, clon, _ = COUNTRIES[country_hit]
            return (country_hit, None, clat, clon)
        return (ccountry, _display(text, key), lat, lon)
    if country_hit:
        lat, lon, _ = COUNTRIES[country_hit]
        return (country_hit, None, lat, lon)
    return None


# Staedte, deren Name in mehreren Laendern vorkommt — hier gewinnt ein explizit
# genanntes Land ueber die Default-Zuordnung in CITIES.
_AMBIG = {"cambridge", "san jose", "córdoba", "santiago", "valencia"}


def _tokens(text: str) -> list[str]:
    flagless = _FLAG.sub(" ", text)
    parts = _SPLIT.split(flagless)
    return [p.strip() for p in parts if p and p.strip()]


def _find_city(text: str):
    """-> (key, country, lat, lon) | None. key = normalisierter CITIES-Schluessel."""
    for tok in _tokens(text):
        key = tok.lower().strip(". ")
        if key in CITIES:
            return (key, *CITIES[key])
    return None


def _display(text: str, key: str) -> str:
    """Original-Schreibweise der getroffenen Stadt (fuer die Anzeige)."""
    for tok in _tokens(text):
        if tok.lower().strip(". ") == key:
            return tok
    return key.title()


_COUNTRY_LC = {name.lower(): name for name in COUNTRIES}


def _find_country(text: str):
    toks = _tokens(text)
    for tok in reversed(toks):  # Land steht meist zuletzt
        key = tok.lower().strip(". ")
        if key in _COUNTRY_LC:
            return _COUNTRY_LC[key]
        if key in ALIASES:
            return ALIASES[key]
        if key in US_STATES or key in US_STATE_NAMES:
            return "United States"
    return None


def demo() -> None:
    cases = {
        "San Francisco, CA": ("United States", "San Francisco"),
        "Berlin, Germany": ("Germany", "Berlin"),
        "Deutschland": ("Germany", None),
        "🇧🇷 São Paulo": ("Brazil", "São Paulo"),
        "London": ("United Kingdom", "London"),
        "北京": ("China", "北京"),
        "Bengaluru, India": ("India", "Bengaluru"),
        "Austin, TX": ("United States", "Austin"),
        "Remote": None,
        "": None,
        "Москва, Россия": ("Russia", "Москва"),
        "🇯🇵": ("Japan", None),
        "Germany": ("Germany", None),          # bare Title-Case Land
        "china": ("China", None),              # bare lowercase Land
        "Netherlands": ("Netherlands", None),
        "Granada, Spain, Europe": ("Spain", None),
        "North Carolina": ("United States", None),  # ausgeschriebener US-Staat
        "Cambridge, UK": ("United Kingdom", None),  # mehrdeutige Stadt, Land gewinnt
    }
    for text, want in cases.items():
        got = geocode(text)
        if want is None:
            assert got is None, f"{text!r} -> {got}, wollte None"
        else:
            assert got is not None, f"{text!r} -> None, wollte {want}"
            assert got[0] == want[0], f"{text!r} Land {got[0]} != {want[0]}"
            assert got[1] == want[1], f"{text!r} Stadt {got[1]} != {want[1]}"
            assert -90 <= got[2] <= 90 and -180 <= got[3] <= 180, f"{text!r} coords {got[2:]}"
    # Land immer in COUNTRIES (fuer Zentroid-Lookups im Frontend).
    for country, *_ in CITIES.values():
        assert country in COUNTRIES, f"Stadt-Land {country} fehlt in COUNTRIES"
    print(f"geo.demo ok — {len(COUNTRIES)} Laender, {len(CITIES)} Staedte")


if __name__ == "__main__":
    demo()
