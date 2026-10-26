import { findPakistanCity } from "@/lib/pakistan-cities"

/**
 * Known warehouse start pins by city key. Karachi Apricart warehouse:
 * 24°50'44.0"N 67°05'55.8"E → decimal degrees.
 */
export const KNOWN_CITY_DEPOTS: Readonly<
  Record<string, { name: string; latitude: number; longitude: number; address: string }>
> = Object.freeze({
  karachi: {
    name: "Karachi Warehouse",
    latitude: 24.8455556,
    longitude: 67.0988333,
    address: "Karachi warehouse (24°50'44.0\"N 67°05'55.8\"E)",
  },
})

export function pakistanCityKey(cityName: string): string {
  return cityName.trim().replace(/\s+/g, " ").toLowerCase()
}

export function resolveRiderCity(input: string): {
  cityKey: string
  cityLabel: string
  province: string
} | null {
  const city = findPakistanCity(input)
  if (!city) return null
  return {
    cityKey: pakistanCityKey(city.name),
    cityLabel: city.name,
    province: city.province,
  }
}

export function knownDepotForCity(cityKey: string) {
  return KNOWN_CITY_DEPOTS[cityKey] ?? null
}
