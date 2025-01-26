import { sanitizeSearchParams } from "@agentic/core";
import { registerFunction } from "./agent.js";
import { z } from "zod";

import defaultKy from "ky"

export namespace weatherapi {
    export const BASE_URL = "https://api.weatherapi.com/v1"

    export interface CurrentWeatherResponse {
        current: CurrentWeather
        location: WeatherLocation
    }

    export interface CurrentWeather {
        cloud: number
        condition: WeatherCondition
        feelslike_c: number
        feelslike_f: number
        gust_kph: number
        gust_mph: number
        humidity: number
        is_day: number
        last_updated: string
        last_updated_epoch: number
        precip_in: number
        precip_mm: number
        pressure_in: number
        pressure_mb: number
        temp_c: number
        temp_f: number
        uv: number
        vis_km: number
        vis_miles: number
        wind_degree: number
        wind_dir: string
        wind_kph: number
        wind_mph: number
    }

    export interface WeatherCondition {
        code: number
        icon: string
        text: string
    }

    export interface WeatherLocation {
        country: string
        lat: number
        localtime: string
        localtime_epoch: number
        lon: number
        name: string
        region: string
        tz_id: string
    }

    export interface WeatherIPInfoResponse {
        ip: string
        type: string
        continent_code: string
        continent_name: string
        country_code: string
        country_name: string
        is_eu: string
        geoname_id: number
        city: string
        region: string
        lat: number
        lon: number
        tz_id: string
        localtime_epoch: number
        localtime: string
    }
}

const ky = defaultKy.extend({
    prefixUrl: weatherapi.BASE_URL
})

registerFunction(
    "get_current_weather",
    "Gets info about the current weather at a given location.",
    z.object({
        q: z
            .string()
            .describe(
                "Location to get the weather for. Can be a city name, zipcode, IP address, or lat/lng coordinates. Example: 'London'"
            )
    }),
    async function (queryOrOptions: string | { q: string }) {
        const options =
            typeof queryOrOptions === "string"
                ? { q: queryOrOptions }
                : queryOrOptions

        return ky
            .get("current.json", {
                searchParams: sanitizeSearchParams({
                    key: process.env.WEATHER_API_KEY,
                    ...options
                })
            })
            .json<weatherapi.CurrentWeatherResponse>()
    }
)