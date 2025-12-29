import {
  writeXmltv,
  type Xmltv,
  type XmltvEpisodeNumber,
  type XmltvProgramme,
} from "@iptv/xmltv";
import parse from "csv-simple-parser";

// Grab schedule for 1 day early. Not much reason to do this other than that
// it might pick up a game otherwise missed if perhaps this was generated at
// exactly the wrong time.
const firstDate = new Date(Date.now() - 86_400_000);

const channelId = "the-spot-tbl";
const xmltv: Xmltv = {
  channels: [
    {
      id: channelId,
      displayName: [{ _value: "Tampa Bay Lightning on The Spot" }],
      icon: [{ src: "https://assets.nhle.com/logos/nhl/svg/TBL_dark.svg" }],
      url: [{ _value: "https://www.nhl.com/lightning/schedule" }],
    },
  ],
  programmes: [],
};

const csvGames: {
  date: string;
  home: string;
  away: string;
  posterUrl?: string;
  thumbUrl?: string;
}[] = [];
try {
  const csv = await Bun.file("images/schedule.csv").text();
  const parsedCsv = parse(csv, { header: true });
  for (const row of parsedCsv) {
    if (Array.isArray(row)) continue;
    const item = row as Record<string, string>;
    const game: (typeof csvGames)[number] = {
      date: item.dateEvent ?? "",
      home: item["Home Team"] ?? "",
      away: item["Away Team"] ?? "",
      posterUrl: item.Poster || undefined,
      thumbUrl: item.Thumb || undefined,
    };

    csvGames.push(game);
  }
} catch (e) {
  console.error(e);
}

const imageUrl = (filename: string) =>
  `https://github.com/shayypy/boltsguide/raw/refs/heads/main/images/${filename}`;

let weeks = 2;
let nextDate = firstDate.toISOString().split("T")[0];
while (weeks > 0) {
  console.log(nextDate);
  const resp = await fetch(`https://api-web.nhle.com/v1/schedule/${nextDate}`);
  if (!resp.ok) {
    console.error(resp);
    throw Error("Failed to fetch");
  }

  const content = (await resp.json()) as ScheduleResponse;
  if (!content.gameWeek) break;

  for (const day of content.gameWeek) {
    const nextDatePre = new Date(day.date);
    nextDatePre.setDate(nextDatePre.getDate() + 1);
    nextDate = nextDatePre.toISOString().split("T")[0];

    if (!day.games) continue;
    for (const game of day.games) {
      const isAway = game.awayTeam.id === 14;
      const isHome = game.homeTeam.id === 14;
      // Not a lightning game. We ignore tvBroadcasts because it usually
      // doesn't actually indicate whether the game will be on the channel.
      if (!isHome && !isAway) continue;

      const symbol = isAway ? "at" : "vs";
      const opponent = isAway ? game.homeTeam : game.awayTeam;

      const seasonYear = String(game.id).slice(0, 4);
      // Including the game type in the number
      const gameNumber = String(game.id).slice(4);

      let startTime = new Date(game.startTimeUTC).getTime();
      // Pre-game - start 30 minutes early
      startTime -= 30 * 60_000;
      // 3 hours
      const endTime = new Date(game.startTimeUTC).getTime() + 10_800_000;
      const programme: XmltvProgramme = {
        channel: channelId,
        title: [
          { _value: "Lightning de Tampa Bay", lang: "fr" },
          { _value: "Tampa Bay Lightning", lang: "en" },
        ],
        subTitle: [
          {
            _value: `${symbol} ${opponent.placeName?.default} ${opponent.commonName?.default}, ${new Date(
              game.startTimeUTC,
            ).toLocaleString("en-US", { month: "short", day: "numeric" })}`,
            lang: "en",
          },
        ],
        episodeNum: [
          {
            _value: `${seasonYear}.${gameNumber}.`,
            system: "xmltv_ns",
          },
          {
            _value: `S${seasonYear}E${gameNumber}`,
            system: "onscreen",
          },
        ],
        image: [
          {
            _value: imageUrl("tbl-poster.png"),
            orient: "P",
            type: "poster",
            size: 3,
          },
        ],
        start: new Date(startTime),
        stop: new Date(endTime),
      };
      const descFooter = `<br/><br/>TV: ${game.tvBroadcasts.map((c) => `${c.network} (${c.countryCode})`).join(" \u2022 ")}`;
      if (game.specialEvent) {
        programme.desc = [
          {
            _value: `${game.specialEvent.name.default} at ${game.venue.default}. ${descFooter}`,
            lang: "en",
          },
        ];
        programme.icon = [{ src: game.specialEvent.lightLogoUrl.default }];
      } else {
        programme.desc = [
          { _value: `At ${game.venue.default}. ${descFooter}`, lang: "en" },
        ];
        programme.icon = [{ src: opponent.darkLogo }];
      }

      const awayName = `${game.awayTeam.placeName.default} ${game.awayTeam.commonName.default}`;
      const homeName = `${game.homeTeam.placeName.default} ${game.homeTeam.commonName.default}`;
      const csvItem =
        csvGames.find((g) => g.away === awayName && g.home === homeName) ??
        // Fall back to reversed matchup if none found
        csvGames.find((g) => g.away === homeName && g.home === awayName);

      if (csvItem?.thumbUrl) {
        programme.image?.push({
          _value: csvItem.thumbUrl,
          orient: "L",
          type: "still",
        });
      }
      // Require date match because poster items seem to usually be for
      // special events. For thumbs, we only care about the matchup
      if (csvItem?.posterUrl && csvItem.date === day.date) {
        programme.image?.push({
          _value: csvItem.posterUrl,
          orient: "P",
          type: "poster",
        });
      }

      xmltv.programmes?.push(programme);
    }
  }

  weeks -= 1;
}

// Generate false programs in the gaps
const programmes = xmltv.programmes ?? [];
const bumpers: XmltvProgramme[] = [];
let i = -1;
for (const programme of programmes) {
  i += 1;
  if (!programme.stop) continue;

  const nextProgramme = programmes[i + 1];
  if (!nextProgramme) break;

  const nextStart = nextProgramme.start.valueOf();
  const lastStop = programme.stop.valueOf();

  const hourIncrementsNum = Math.ceil((nextStart - lastStop) / 3_600_000);
  if (hourIncrementsNum < 12) continue;

  for (const incr of new Array(hourIncrementsNum)
    .fill(undefined)
    .map((_, i) => i)) {
    // biome-ignore lint/style/noNonNullAssertion: We always provide this
    const xmltvns = programme.episodeNum!.find((e) => e.system === "xmltv_ns")!;
    const epNum: XmltvEpisodeNumber = {
      _value: xmltvns._value + String(incr),
      system: "xmltv_ns",
    };

    bumpers.push({
      channel: channelId,
      title: [{ _value: "Tampa Bumper" }],
      episodeNum: [
        epNum,
        ...(programme.episodeNum?.filter((e) => e.system !== "xmltv_ns") ?? []),
      ],
      image: [
        {
          _value: imageUrl("vasy.jpg"),
          orient: "L",
          type: "backdrop",
        },
        {
          _value: imageUrl("tbl-poster.png"),
          orient: "P",
          type: "poster",
          size: 3,
        },
      ],
      start: new Date(lastStop + incr * 3600000),
      stop: new Date(Math.min(lastStop + (incr + 1) * 3600000, nextStart)),
    });
  }
  xmltv.programmes?.push(...bumpers);
}

await Bun.write("./guide.xml", writeXmltv(xmltv));
// console.log(writeXmltv(xmltv));

interface GameTeam {
  id: number;
  commonName: { default: string };
  placeName: { default: string };
  placeNameWithPreposition: {
    default: string;
    fr: string;
  };
  abbrev: string;
  logo: string;
  darkLogo: string;
  awaySplitSquad: false;
  radioLink: string;
}

interface Game {
  id: number;
  season: number;
  gameType: number;
  venue: { default: string; fr?: string };
  neutralSite: boolean;
  startTimeUTC: string;
  easternUTCOffset: string;
  venueUTCOffset: string;
  venueTimezone: string;
  gameState: string;
  gameScheduleState: string;
  tvBroadcasts: {
    id: number;
    market: string;
    countryCode: "US" | "CA";
    network: string;
    sequenceNumber: number;
  }[];
  awayTeam: GameTeam;
  homeTeam: GameTeam;
  periodDescriptor: {
    number: number;
    periodType: string;
    maxRegulationPeriods: number;
  };
  specialEvent?: {
    parentId: number;
    name: { default: string };
    lightLogoUrl: { default: string; fr?: string };
  };
  ticketsLink: string;
  ticketsLinkFr: string;
  gameCenterLink: string;
}

interface GameWeekDay {
  date: string;
  dayAbbrev: string;
  numberOfGames: number;
  datePromo: unknown[];
  games: Game[];
}

interface ScheduleResponse {
  nextStartDate: string;
  previousStartDate: string;
  gameWeek: GameWeekDay[];
  preSeasonStartDate: string;
  regularSeasonStartDate: string;
  regularSeasonEndDate: string;
  playoffEndDate: string;
  numberOfGames: number;
}
