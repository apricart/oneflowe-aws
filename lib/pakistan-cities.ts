/**
 * Pakistan's cities, each with its province, one spelling each
 * (plans/OF-JOIN-new-branch-city-warehouse.md).
 *
 * The list a new branch's city is chosen from, by the applicant on the
 * department sign-up and again by Head Office when it approves
 * (plans/OF-JOIN-applicant-new-branch-city.md). The server refuses a city that is not here and stores
 * the spelling given here, so every branch created that way names its city
 * the same way — which is what a warehouse's whole-city assignment matches on.
 *
 * A town that is missing is added here; until then the nearest listed city is
 * chosen.
 */

export const PAKISTAN_PROVINCES = [
  "Punjab",
  "Sindh",
  "Khyber Pakhtunkhwa",
  "Balochistan",
  "Islamabad Capital Territory",
  "Gilgit-Baltistan",
  "Azad Jammu and Kashmir",
] as const

export type PakistanProvince = (typeof PAKISTAN_PROVINCES)[number]

export type PakistanCity = { name: string; province: PakistanProvince }

const CITIES_BY_PROVINCE: Record<PakistanProvince, readonly string[]> = {
  "Islamabad Capital Territory": ["Islamabad"],
  Punjab: [
    "Ahmadpur East", "Ahmadpur Sial", "Alipur", "Arifwala", "Attock",
    "Bahawalnagar", "Bahawalpur", "Basirpur", "Bhakkar", "Bhalwal", "Bhera", "Burewala",
    "Chak Jhumra", "Chakwal", "Chichawatni", "Chiniot", "Chishtian", "Chunian",
    "Daska", "Depalpur", "Dera Ghazi Khan", "Dina", "Dunyapur",
    "Faisalabad", "Fateh Jang", "Ferozewala", "Fort Abbas",
    "Gojra", "Gujar Khan", "Gujranwala", "Gujrat",
    "Hafizabad", "Haroonabad", "Hasan Abdal", "Hasilpur", "Hazro",
    "Jalalpur Jattan", "Jalalpur Pirwala", "Jampur", "Jaranwala", "Jatoi", "Jauharabad", "Jhang", "Jhelum",
    "Kabirwala", "Kahror Pakka", "Kahuta", "Kalabagh", "Kamalia", "Kamoke", "Kasur", "Khanewal",
    "Khanpur", "Kharian", "Khushab", "Kot Addu", "Kot Momin", "Kot Radha Kishan",
    "Lahore", "Lalamusa", "Layyah", "Liaquatpur", "Lodhran",
    "Mailsi", "Malakwal", "Mandi Bahauddin", "Mian Channu", "Mianwali", "Minchinabad", "Multan",
    "Muridke", "Murree", "Muzaffargarh",
    "Nankana Sahib", "Narowal", "Nowshera Virkan",
    "Okara",
    "Pakpattan", "Pasrur", "Pattoki", "Phalia", "Pind Dadan Khan", "Pindi Bhattian", "Pir Mahal",
    "Rahim Yar Khan", "Raiwind", "Rajanpur", "Rawalpindi", "Renala Khurd",
    "Sadiqabad", "Safdarabad", "Sahiwal", "Sambrial", "Samundri", "Sangla Hill", "Sarai Alamgir",
    "Sargodha", "Shakargarh", "Sharaqpur", "Sheikhupura", "Shorkot", "Shujabad", "Sialkot",
    "Sillanwali",
    "Talagang", "Tandlianwala", "Taunsa", "Taxila", "Toba Tek Singh",
    "Vehari",
    "Wah Cantonment", "Wazirabad",
    "Yazman",
    "Zafarwal",
  ],
  Sindh: [
    "Badin", "Bhiria", "Dadu", "Daharki", "Digri",
    "Gambat", "Ghotki",
    "Hala", "Hyderabad",
    "Jacobabad", "Jamshoro", "Jhudo",
    "Kandhkot", "Kandiaro", "Karachi", "Kashmore", "Khairpur", "Kotri", "Kunri",
    "Larkana",
    "Matiari", "Mehar", "Mirpur Khas", "Mirpur Mathelo", "Mithi", "Moro",
    "Naushahro Feroze", "Nawabshah",
    "Pano Aqil",
    "Qambar",
    "Ratodero", "Rohri",
    "Sakrand", "Sanghar", "Sehwan", "Shahdadkot", "Shahdadpur", "Shikarpur", "Sujawal", "Sukkur",
    "Tando Adam", "Tando Allahyar", "Tando Jam", "Tando Muhammad Khan", "Thatta", "Thul",
    "Ubauro", "Umerkot",
  ],
  "Khyber Pakhtunkhwa": [
    "Abbottabad", "Alpuri",
    "Bannu", "Batkhela", "Battagram",
    "Chakdara", "Charsadda", "Chitral",
    "Daggar", "Dasu", "Dera Ismail Khan", "Dir",
    "Hangu", "Haripur", "Havelian",
    "Jamrud",
    "Karak", "Khar", "Kohat",
    "Lakki Marwat", "Landi Kotal",
    "Mansehra", "Mardan", "Mingora", "Miran Shah",
    "Nowshera",
    "Parachinar", "Pabbi", "Peshawar",
    "Risalpur",
    "Saidu Sharif", "Shabqadar", "Swabi",
    "Takht-i-Bahi", "Tank", "Timergara", "Topi",
    "Wana",
  ],
  Balochistan: [
    "Awaran",
    "Barkhan", "Bela",
    "Chaman",
    "Dalbandin", "Dera Allah Yar", "Dera Bugti", "Dera Murad Jamali", "Dhadar", "Duki",
    "Gandava", "Gwadar",
    "Harnai", "Hub",
    "Jiwani",
    "Kalat", "Kharan", "Khuzdar", "Kohlu",
    "Loralai",
    "Mastung", "Musakhel",
    "Nushki",
    "Ormara",
    "Panjgur", "Pasni", "Pishin",
    "Qila Abdullah", "Qila Saifullah", "Quetta",
    "Sibi", "Sui", "Surab",
    "Turbat",
    "Usta Muhammad", "Uthal",
    "Washuk",
    "Ziarat", "Zhob",
  ],
  "Gilgit-Baltistan": [
    "Aliabad", "Astore",
    "Chilas",
    "Gahkuch", "Gilgit",
    "Karimabad", "Khaplu",
    "Shigar", "Skardu",
  ],
  "Azad Jammu and Kashmir": [
    "Athmuqam",
    "Bagh", "Bhimber",
    "Dadyal",
    "Hattian Bala",
    "Kotli",
    "Mirpur", "Muzaffarabad",
    "Pallandri",
    "Rawalakot",
  ],
}

/** Every listed city, alphabetically. */
export const PAKISTAN_CITIES: readonly PakistanCity[] = Object.freeze(
  PAKISTAN_PROVINCES
    .flatMap((province) => CITIES_BY_PROVINCE[province].map((name) => ({ name, province })))
    .sort((a, b) => a.name.localeCompare(b.name)),
)

/** Case and spacing aside: how a typed or sent city is matched against the list. */
function listKey(value: string): string {
  return value.trim().replaceAll(/\s+/g, " ").toLowerCase()
}

const CITY_BY_KEY = new Map(PAKISTAN_CITIES.map((city) => [listKey(city.name), city]))

/**
 * The listed city a value names, case and spacing aside, or null when it is
 * not on the list. List membership only: a warehouse's city is matched in SQL
 * (`branchCityKeySql`), never by this.
 */
export function findPakistanCity(value: unknown): PakistanCity | null {
  if (typeof value !== "string") return null
  return CITY_BY_KEY.get(listKey(value)) ?? null
}
