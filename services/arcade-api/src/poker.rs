//! Texas Hold'em referee — server-authoritative so hole cards stay private.
//!
//! One `Table` per poker room. The hub feeds it player actions and delivers the
//! messages it emits: public table state broadcast to the room, plus each
//! player's hole cards sent only to them.
//!
//! Simplification: a single main pot (all-in players are eligible for the whole
//! pot). Proper side-pots aren't modelled — fine for friendly games, noted here.

use rand::seq::SliceRandom;
use serde_json::{json, Value};

const BUYIN: i64 = 1000;
const SMALL_BLIND: i64 = 5;
const BIG_BLIND: i64 = 10;
pub const NUM_SEATS: usize = 6;

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Card {
    pub rank: u8, // 2..=14 (14 = Ace)
    pub suit: u8, // 0..=3 -> c d h s
}
impl Card {
    fn code(&self) -> String {
        let r = match self.rank {
            14 => 'A', 13 => 'K', 12 => 'Q', 11 => 'J', 10 => 'T',
            n => (b'0' + n) as char,
        };
        format!("{}{}", r, b"cdhs"[self.suit as usize] as char)
    }
}

fn full_deck() -> Vec<Card> {
    let mut d = Vec::with_capacity(52);
    for suit in 0..4 {
        for rank in 2..=14 {
            d.push(Card { rank, suit });
        }
    }
    d
}

// --- Hand evaluation -------------------------------------------------------
// Returns [category, t1, t2, t3, t4, t5]; compare arrays lexicographically.
// category: 8 straight-flush, 7 quads, 6 full house, 5 flush, 4 straight,
//           3 trips, 2 two-pair, 1 pair, 0 high card.
fn eval5(cards: &[Card; 5]) -> [u8; 6] {
    let mut ranks: Vec<u8> = cards.iter().map(|c| c.rank).collect();
    ranks.sort_unstable_by(|a, b| b.cmp(a)); // descending
    let flush = cards.iter().all(|c| c.suit == cards[0].suit);

    let mut uniq = ranks.clone();
    uniq.dedup();
    let mut straight_high = 0u8;
    if uniq.len() == 5 {
        if uniq[0] - uniq[4] == 4 {
            straight_high = uniq[0];
        } else if uniq == [14, 5, 4, 3, 2] {
            straight_high = 5; // wheel
        }
    }

    // groups: (count, rank), sorted by count desc then rank desc
    let mut counts: std::collections::HashMap<u8, u8> = std::collections::HashMap::new();
    for &r in &ranks {
        *counts.entry(r).or_insert(0) += 1;
    }
    let mut groups: Vec<(u8, u8)> = counts.into_iter().map(|(r, c)| (c, r)).collect();
    groups.sort_unstable_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));

    let mut tb = [0u8; 5];
    let cat;
    if straight_high > 0 && flush {
        cat = 8; tb[0] = straight_high;
    } else if groups[0].0 == 4 {
        cat = 7; tb[0] = groups[0].1; tb[1] = groups[1].1;
    } else if groups[0].0 == 3 && groups.len() > 1 && groups[1].0 == 2 {
        cat = 6; tb[0] = groups[0].1; tb[1] = groups[1].1;
    } else if flush {
        cat = 5; tb.copy_from_slice(&ranks[..5]);
    } else if straight_high > 0 {
        cat = 4; tb[0] = straight_high;
    } else if groups[0].0 == 3 {
        cat = 3; tb[0] = groups[0].1; tb[1] = groups[1].1; tb[2] = groups[2].1;
    } else if groups[0].0 == 2 && groups.len() > 1 && groups[1].0 == 2 {
        cat = 2; tb[0] = groups[0].1; tb[1] = groups[1].1; tb[2] = groups[2].1;
    } else if groups[0].0 == 2 {
        cat = 1; tb[0] = groups[0].1; tb[1] = groups[1].1; tb[2] = groups[2].1; tb[3] = groups[3].1;
    } else {
        cat = 0; tb.copy_from_slice(&ranks[..5]);
    }
    [cat, tb[0], tb[1], tb[2], tb[3]]
}

/// Best 5-card evaluation from 7 cards.
pub fn eval7(cards: &[Card]) -> [u8; 6] {
    let mut best = [0u8; 6];
    let n = cards.len();
    for i in 0..n {
        for j in (i + 1)..n {
            let mut h = [cards[0]; 5];
            let mut k = 0;
            for (x, &c) in cards.iter().enumerate() {
                if x != i && x != j {
                    h[k] = c;
                    k += 1;
                }
            }
            let e = eval5(&h);
            if e > best {
                best = e;
            }
        }
    }
    best
}

fn hand_name(e: &[u8; 6]) -> &'static str {
    match e[0] {
        8 => "Straight Flush", 7 => "Four of a Kind", 6 => "Full House", 5 => "Flush",
        4 => "Straight", 3 => "Three of a Kind", 2 => "Two Pair", 1 => "Pair", _ => "High Card",
    }
}

// --- Table -----------------------------------------------------------------
#[derive(Clone)]
struct Seat {
    nick: String,
    chips: i64,
    bet: i64,       // contributed this betting round
    committed: i64, // contributed this hand (for the pot)
    folded: bool,
    allin: bool,
    acted: bool,
    in_hand: bool,
    hole: Vec<Card>,
}

pub struct Out {
    pub to: Option<String>, // None = broadcast to room, Some(nick) = private
    pub msg: Value,
}

pub struct Table {
    seats: Vec<Option<Seat>>,
    deck: Vec<Card>,
    board: Vec<Card>,
    pot: i64,
    stage: u8, // 0 waiting, 1 preflop, 2 flop, 3 turn, 4 river
    dealer: usize,
    to_act: usize,
    current_bet: i64,
    min_raise: i64,
    hand_active: bool,
}

impl Table {
    pub fn new() -> Self {
        Table {
            seats: (0..NUM_SEATS).map(|_| None).collect(),
            deck: Vec::new(),
            board: Vec::new(),
            pot: 0,
            stage: 0,
            dealer: 0,
            to_act: 0,
            current_bet: 0,
            min_raise: BIG_BLIND,
            hand_active: false,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.seats.iter().all(|s| s.is_none())
    }

    fn seat_of(&self, nick: &str) -> Option<usize> {
        self.seats.iter().position(|s| s.as_ref().map(|x| x.nick == nick).unwrap_or(false))
    }

    /// Handle a player action; returns messages to deliver.
    pub fn handle(&mut self, nick: &str, g: &Value) -> Vec<Out> {
        let act = g.get("do").and_then(|x| x.as_str()).unwrap_or("");
        match act {
            "sit" => self.sit(nick),
            "leave" => self.leave(nick),
            "start" => self.start_hand(),
            "state" => self.broadcast_state(),
            "fold" | "check" | "call" | "raise" => {
                let amount = g.get("amount").and_then(|x| x.as_i64()).unwrap_or(0);
                self.player_action(nick, act, amount)
            }
            _ => vec![],
        }
    }

    fn sit(&mut self, nick: &str) -> Vec<Out> {
        if self.seat_of(nick).is_some() {
            return vec![];
        }
        if let Some(slot) = self.seats.iter_mut().find(|s| s.is_none()) {
            *slot = Some(Seat {
                nick: nick.to_string(), chips: BUYIN, bet: 0, committed: 0,
                folded: false, allin: false, acted: false, in_hand: false, hole: Vec::new(),
            });
        }
        self.broadcast_state()
    }

    fn leave(&mut self, nick: &str) -> Vec<Out> {
        if let Some(i) = self.seat_of(nick) {
            // fold first if in a live hand
            if self.hand_active {
                if let Some(s) = self.seats[i].as_mut() {
                    s.folded = true;
                }
            }
            self.seats[i] = None;
        }
        if self.hand_active {
            let mut out = self.maybe_end_hand();
            if out.is_empty() {
                out = self.broadcast_state();
            }
            out
        } else {
            self.broadcast_state()
        }
    }

    fn active_seats(&self) -> Vec<usize> {
        (0..NUM_SEATS).filter(|&i| self.seats[i].as_ref().map(|s| s.in_hand && !s.folded).unwrap_or(false)).collect()
    }

    fn start_hand(&mut self) -> Vec<Out> {
        if self.hand_active {
            return vec![];
        }
        let players: Vec<usize> = (0..NUM_SEATS)
            .filter(|&i| self.seats[i].as_ref().map(|s| s.chips > 0).unwrap_or(false))
            .collect();
        if players.len() < 2 {
            return vec![];
        }

        self.deck = full_deck();
        self.deck.shuffle(&mut rand::thread_rng());
        self.board.clear();
        self.pot = 0;
        self.stage = 1;
        self.current_bet = 0;
        self.min_raise = BIG_BLIND;
        self.hand_active = true;

        for i in 0..NUM_SEATS {
            if let Some(s) = self.seats[i].as_mut() {
                s.bet = 0; s.committed = 0; s.folded = false; s.allin = false; s.acted = false;
                s.hole.clear();
                s.in_hand = s.chips > 0;
            }
        }
        // advance dealer to next player
        self.dealer = self.next_occupied(self.dealer);

        // deal two hole cards each, in order
        for _ in 0..2 {
            let order = self.order_from(self.next_occupied(self.dealer));
            for i in order {
                if let Some(c) = self.deck.pop() {
                    if let Some(s) = self.seats[i].as_mut() {
                        if s.in_hand {
                            s.hole.push(c);
                        }
                    }
                }
            }
        }

        // blinds
        let sb = self.next_occupied(self.dealer);
        let bb = self.next_occupied(sb);
        self.post(sb, SMALL_BLIND);
        self.post(bb, BIG_BLIND);
        self.current_bet = BIG_BLIND;
        self.to_act = self.next_active(bb);

        let mut out = self.deal_holes();
        out.extend(self.broadcast_state());
        out
    }

    fn post(&mut self, i: usize, amount: i64) {
        if let Some(s) = self.seats[i].as_mut() {
            let a = amount.min(s.chips);
            s.chips -= a;
            s.bet += a;
            s.committed += a;
            self.pot += a;
            if s.chips == 0 {
                s.allin = true;
            }
        }
    }

    fn next_occupied(&self, from: usize) -> usize {
        for step in 1..=NUM_SEATS {
            let i = (from + step) % NUM_SEATS;
            if self.seats[i].as_ref().map(|s| s.in_hand).unwrap_or(false) {
                return i;
            }
        }
        from
    }
    fn next_active(&self, from: usize) -> usize {
        for step in 1..=NUM_SEATS {
            let i = (from + step) % NUM_SEATS;
            if self.seats[i].as_ref().map(|s| s.in_hand && !s.folded && !s.allin).unwrap_or(false) {
                return i;
            }
        }
        from
    }
    fn order_from(&self, start: usize) -> Vec<usize> {
        let mut v = Vec::new();
        for step in 0..NUM_SEATS {
            let i = (start + step) % NUM_SEATS;
            if self.seats[i].as_ref().map(|s| s.in_hand).unwrap_or(false) {
                v.push(i);
            }
        }
        v
    }

    fn player_action(&mut self, nick: &str, act: &str, amount: i64) -> Vec<Out> {
        let i = match self.seat_of(nick) {
            Some(i) if self.hand_active && i == self.to_act => i,
            _ => return vec![],
        };
        {
            let s = self.seats[i].as_mut().unwrap();
            if s.folded || s.allin {
                return vec![];
            }
            match act {
                "fold" => { s.folded = true; s.acted = true; }
                "check" => {
                    if s.bet < self.current_bet {
                        return vec![]; // can't check facing a bet
                    }
                    s.acted = true;
                }
                "call" => {
                    let need = (self.current_bet - s.bet).min(s.chips);
                    s.chips -= need; s.bet += need; s.committed += need; self.pot += need;
                    if s.chips == 0 { s.allin = true; }
                    s.acted = true;
                }
                "raise" => {
                    // amount = total bet the player wants to have this round
                    let target = amount.max(self.current_bet + self.min_raise);
                    let to_put = (target - s.bet).min(s.chips);
                    if to_put <= (self.current_bet - s.bet) {
                        return vec![]; // not a real raise
                    }
                    s.chips -= to_put; s.bet += to_put; s.committed += to_put; self.pot += to_put;
                    let raise_by = s.bet - self.current_bet;
                    if raise_by > 0 { self.min_raise = raise_by; }
                    self.current_bet = s.bet.max(self.current_bet);
                    if s.chips == 0 { s.allin = true; }
                    s.acted = true;
                    // a raise reopens action for everyone else
                    for (j, seat) in self.seats.iter_mut().enumerate() {
                        if j != i {
                            if let Some(o) = seat {
                                if o.in_hand && !o.folded && !o.allin {
                                    o.acted = false;
                                }
                            }
                        }
                    }
                }
                _ => return vec![],
            }
        }

        // hand ends early if only one player remains
        if self.active_seats().len() <= 1 {
            return self.showdown();
        }
        // is the betting round complete?
        if self.round_complete() {
            return self.advance_stage();
        }
        self.to_act = self.next_active(self.to_act);
        self.broadcast_state()
    }

    fn round_complete(&self) -> bool {
        for i in 0..NUM_SEATS {
            if let Some(s) = &self.seats[i] {
                if s.in_hand && !s.folded && !s.allin && (!s.acted || s.bet < self.current_bet) {
                    return false;
                }
            }
        }
        true
    }

    fn advance_stage(&mut self) -> Vec<Out> {
        // reset per-round betting
        for s in self.seats.iter_mut().flatten() {
            s.bet = 0;
            s.acted = false;
        }
        self.current_bet = 0;
        self.min_raise = BIG_BLIND;

        // if everyone remaining is all-in, run it out to showdown
        let can_bet = (0..NUM_SEATS).filter(|&i| self.seats[i].as_ref().map(|s| s.in_hand && !s.folded && !s.allin).unwrap_or(false)).count();

        self.stage += 1;
        match self.stage {
            2 => { for _ in 0..3 { if let Some(c) = self.deck.pop() { self.board.push(c); } } } // flop
            3 | 4 => { if let Some(c) = self.deck.pop() { self.board.push(c); } } // turn / river
            _ => return self.showdown(),
        }

        if can_bet <= 1 {
            // no more betting possible — keep dealing to showdown
            return self.advance_stage();
        }
        self.to_act = self.next_active(self.dealer);
        self.broadcast_state()
    }

    fn maybe_end_hand(&mut self) -> Vec<Out> {
        if self.hand_active && self.active_seats().len() <= 1 {
            self.showdown()
        } else {
            vec![]
        }
    }

    fn showdown(&mut self) -> Vec<Out> {
        let contenders = self.active_seats();
        let mut results: Vec<Value> = Vec::new();
        let mut winners: Vec<usize> = Vec::new();

        if contenders.len() == 1 {
            winners = contenders.clone();
        } else {
            let mut best: Option<[u8; 6]> = None;
            for &i in &contenders {
                let s = self.seats[i].as_ref().unwrap();
                let mut seven = s.hole.clone();
                seven.extend(self.board.iter().copied());
                let e = eval7(&seven);
                results.push(json!({
                    "nick": s.nick,
                    "hand": hand_name(&e),
                    "cards": s.hole.iter().map(|c| c.code()).collect::<Vec<_>>(),
                }));
                match best {
                    Some(b) if e > b => { best = Some(e); winners = vec![i]; }
                    Some(b) if e == b => winners.push(i),
                    None => { best = Some(e); winners = vec![i]; }
                    _ => {}
                }
            }
        }

        // award pot (split evenly among winners)
        let share = if winners.is_empty() { 0 } else { self.pot / winners.len() as i64 };
        let mut names = Vec::new();
        for &i in &winners {
            if let Some(s) = self.seats[i].as_mut() {
                s.chips += share;
                names.push(s.nick.clone());
            }
        }

        let board: Vec<String> = self.board.iter().map(|c| c.code()).collect();
        let msg = Out {
            to: None,
            msg: json!({
                "a": "poker", "ev": "showdown", "pot": self.pot,
                "board": board, "winners": names, "results": results,
            }),
        };
        // reset to waiting
        self.hand_active = false;
        self.stage = 0;
        self.pot = 0;
        self.board.clear();
        for s in self.seats.iter_mut().flatten() {
            s.in_hand = false; s.folded = false; s.allin = false; s.bet = 0; s.hole.clear();
        }

        let mut out = vec![msg];
        out.extend(self.broadcast_state());
        out
    }

    fn deal_holes(&mut self) -> Vec<Out> {
        let mut out = Vec::new();
        for s in self.seats.iter().flatten() {
            if s.in_hand && !s.hole.is_empty() {
                out.push(Out {
                    to: Some(s.nick.clone()),
                    msg: json!({ "a": "poker", "ev": "hole", "cards": s.hole.iter().map(|c| c.code()).collect::<Vec<_>>() }),
                });
            }
        }
        out
    }

    fn broadcast_state(&self) -> Vec<Out> {
        let seats: Vec<Value> = self.seats.iter().enumerate().map(|(i, s)| match s {
            Some(s) => json!({
                "seat": i, "nick": s.nick, "chips": s.chips, "bet": s.bet,
                "folded": s.folded, "allin": s.allin, "inHand": s.in_hand,
                "acting": self.hand_active && i == self.to_act,
                "dealer": i == self.dealer,
            }),
            None => json!({ "seat": i, "empty": true }),
        }).collect();

        let to_act_nick = if self.hand_active {
            self.seats[self.to_act].as_ref().map(|s| s.nick.clone())
        } else {
            None
        };

        vec![Out {
            to: None,
            msg: json!({
                "a": "poker", "ev": "state",
                "stage": self.stage, "handActive": self.hand_active,
                "pot": self.pot, "currentBet": self.current_bet, "minRaise": self.min_raise,
                "board": self.board.iter().map(|c| c.code()).collect::<Vec<_>>(),
                "toAct": to_act_nick, "seats": seats,
            }),
        }]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn c(s: &str) -> Card {
        let b = s.as_bytes();
        let rank = match b[0] { b'A' => 14, b'K' => 13, b'Q' => 12, b'J' => 11, b'T' => 10, n => n - b'0' };
        let suit = "cdhs".find(b[1] as char).unwrap() as u8;
        Card { rank, suit }
    }
    fn hand(s: &str) -> Vec<Card> { s.split_whitespace().map(c).collect() }

    #[test]
    fn categories_rank_correctly() {
        let sf = eval7(&hand("As Ks Qs Js Ts 2c 3d")); // royal (straight flush)
        let quads = eval7(&hand("Ah Ad Ac As Kd 2c 3d"));
        let boat = eval7(&hand("Ah Ad Ac Kh Kd 2c 3d"));
        let flush = eval7(&hand("Ah Th 7h 4h 2h Kd Qc"));
        let straight = eval7(&hand("9h Td Jc Qs Kh 2c 3d"));
        let trips = eval7(&hand("Ah Ad Ac Kh Qd 2c 3s"));
        let two_pair = eval7(&hand("Ah Ad Kh Kd Qc 2s 3d"));
        let pair = eval7(&hand("Ah Ad Kh Qd Jc 2s 3d"));
        let high = eval7(&hand("Ah Kd Qh Jc 9s 2d 3c"));
        assert!(sf > quads && quads > boat && boat > flush && flush > straight);
        assert!(straight > trips && trips > two_pair && two_pair > pair && pair > high);
        assert_eq!(sf[0], 8);
        assert_eq!(high[0], 0);
    }

    #[test]
    fn wheel_straight_and_kickers() {
        let wheel = eval7(&hand("Ah 2d 3c 4s 5h Kd Qc")); // A-5 straight
        assert_eq!(wheel[0], 4);
        assert_eq!(wheel[1], 5); // high card of wheel is the 5
        // kicker matters: pair of aces, K kicker beats Q kicker
        let ak = eval7(&hand("Ah Ad Kh 7c 4s 2d 3c"));
        let aq = eval7(&hand("Ah Ad Qh 7c 4s 2d 3c"));
        assert!(ak > aq);
    }

    #[test]
    fn best_of_seven() {
        // board makes a flush; player hole completes it
        let e = eval7(&hand("Ah Kh Qh Jh 2h 3c 4d"));
        assert_eq!(e[0], 5); // flush, not just straight
    }
}
