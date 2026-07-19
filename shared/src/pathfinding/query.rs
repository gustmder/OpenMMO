//! Read-only spatial queries against the runtime passability cache. Two
//! flavours: per-edge collision checks (whether stepping or sliding from
//! one cell to a neighbour crosses a wall) used by both A* expansion and
//! continuous player movement, plus floor-level lookups that translate a
//! `(x, z, y)` world position to the floor it belongs to.

use super::{PassabilityCache, RuntimeFloorGrid, EDGE_E, EDGE_N, EDGE_S, EDGE_W};

/// Check if a cardinal (1-cell) move is blocked on a specific floor level.
/// Matches by `floor_level` only — no Y-range check, no proximity buffer.
///
/// `#[inline]` because this is hit per-neighbour by both A* expansion
/// (`astar::find_path`) and Bresenham line-of-sight (`smooth::is_line_passable`),
/// and lives in a different module than both callers.
#[inline]
pub fn is_cardinal_move_blocked(
    cache: &PassabilityCache,
    cell_x: i32,
    cell_z: i32,
    dx: i32,
    dz: i32,
    floor_level: u8,
) -> bool {
    let nx = cell_x + dx;
    let nz = cell_z + dz;
    let (leave_bit, enter_bit) = match (dx, dz) {
        (1, 0) => (EDGE_E, EDGE_W),
        (-1, 0) => (EDGE_W, EDGE_E),
        (0, 1) => (EDGE_S, EDGE_N),
        (0, -1) => (EDGE_N, EDGE_S),
        _ => return false,
    };

    let cx_f = cell_x as f32;
    let nxf = nx as f32;
    let cz_f = cell_z as f32;
    let nzf = nz as f32;
    for rp in cache.values() {
        if cx_f < rp.min_x && nxf < rp.min_x {
            continue;
        }
        if cx_f > rp.max_x && nxf > rp.max_x {
            continue;
        }
        if cz_f < rp.min_z && nzf < rp.min_z {
            continue;
        }
        if cz_f > rp.max_z && nzf > rp.max_z {
            continue;
        }

        let house_ox = rp.house_origin_x.floor() as i32;
        let house_oz = rp.house_origin_z.floor() as i32;
        for floor in &rp.floors {
            if floor.floor_level != floor_level {
                continue;
            }
            let fx = house_ox + floor.origin_x;
            let fz = house_oz + floor.origin_z;
            let w = floor.width as i32;
            let d = floor.depth as i32;

            let gx = cell_x - fx;
            let gz = cell_z - fz;
            if gx >= 0
                && gx < w
                && gz >= 0
                && gz < d
                && floor.cells[(gx + gz * w) as usize] & leave_bit != 0
            {
                return true;
            }

            let ngx = nx - fx;
            let ngz = nz - fz;
            if ngx >= 0
                && ngx < w
                && ngz >= 0
                && ngz < d
                && floor.cells[(ngx + ngz * w) as usize] & enter_bit != 0
            {
                return true;
            }
        }
    }
    false
}

/// Check if movement from→to crosses any blocked cell edge on `floor_level`.
///
/// Floor indices are globally unique across the cache — housing uses 0..3 and
/// dungeons start at `dungeon::DUNGEON_FLOOR_INDEX_BASE` — so an exact match is
/// all it takes to keep a crypt's walls away from the houses above it.
pub fn is_movement_blocked(
    cache: &PassabilityCache,
    from_x: f32,
    from_z: f32,
    to_x: f32,
    to_z: f32,
    floor_level: u8,
    y: Option<f32>,
) -> bool {
    let min_x = from_x.min(to_x);
    let max_x = from_x.max(to_x);
    let min_z = from_z.min(to_z);
    let max_z = from_z.max(to_z);

    for rp in cache.values() {
        if max_x < rp.min_x || min_x > rp.max_x || max_z < rp.min_z || min_z > rp.max_z {
            continue;
        }

        // A stairwell is stored in *both* connected floors' grids with opposite
        // ends sealed, so whichever grid the mover is keyed to seals the end
        // they are standing on. Consult both and block only when both refuse.
        let stair_mask = stairwell_floor_mask(rp, min_x, max_x, min_z, max_z, floor_level);
        if stair_mask != 0 {
            let mut connected = rp
                .floors
                .iter()
                .filter(|f| stair_mask & floor_bit(f.floor_level) != 0)
                .filter(|f| obstacle_reaches_y(f, y))
                .peekable();
            if connected.peek().is_some()
                && connected.all(|f| move_blocked_on_floor(rp, f, from_x, from_z, to_x, to_z))
            {
                return true;
            }
            continue;
        }

        for floor in &rp.floors {
            if floor.floor_level != floor_level || !obstacle_reaches_y(floor, y) {
                continue;
            }
            if move_blocked_on_floor(rp, floor, from_x, from_z, to_x, to_z) {
                return true;
            }
        }
    }
    false
}

#[inline]
fn floor_bit(floor_level: u8) -> u32 {
    1u32 << floor_level.min(31)
}

/// Whether an obstacle on `floor` is tall enough to reach a mover at `y`.
///
/// Floor level says *which storey*; this says whether the thing on it actually
/// reaches you. Walls span the storey, but furniture is only
/// `FURNITURE_BLOCK_HEIGHT` tall, and a staircase runs above the floor it
/// stands on — so someone mid-stairs must clear the tables below them.
///
/// Deliberately one-sided: an equivalent lower bound is what used to trap
/// players at the foot of a stairwell, because a blocked step never moves them
/// and so never corrects the Y that blocked it. `None` means "no Y known"
/// (path smoothing) and conservatively applies every obstacle on the floor.
#[inline]
fn obstacle_reaches_y(floor: &RuntimeFloorGrid, y: Option<f32>) -> bool {
    match y {
        Some(y) => y < floor.y_base + floor.wall_height,
        None => true,
    }
}

/// Bitmask of floor levels connected by a stairwell this move touches that the
/// mover is actually keyed to, or 0 otherwise. Touching (rather than
/// containment) is what matters: stepping off a landing into the adjoining room
/// is exactly the move the other floor's grid seals.
fn stairwell_floor_mask(
    rp: &super::RuntimePassability,
    min_x: f32,
    max_x: f32,
    min_z: f32,
    max_z: f32,
    floor_level: u8,
) -> u32 {
    if rp.stairwells.is_empty() {
        return 0;
    }
    let mut mask = 0;
    for stair in &rp.stairwells {
        if stair.lower_floor != floor_level && stair.upper_floor != floor_level {
            continue;
        }
        let sx0 = rp.house_origin_x + stair.local_min_x as f32;
        let sx1 = rp.house_origin_x + stair.local_max_x as f32;
        let sz0 = rp.house_origin_z + stair.local_min_z as f32;
        let sz1 = rp.house_origin_z + stair.local_max_z as f32;
        if max_x >= sx0 && min_x <= sx1 && max_z >= sz0 && min_z <= sz1 {
            mask |= floor_bit(stair.lower_floor) | floor_bit(stair.upper_floor);
        }
    }
    mask
}

/// Whether from→to crosses a blocked cell edge on one specific floor grid.
fn move_blocked_on_floor(
    rp: &super::RuntimePassability,
    floor: &RuntimeFloorGrid,
    from_x: f32,
    from_z: f32,
    to_x: f32,
    to_z: f32,
) -> bool {
    let local_from_x = from_x - rp.house_origin_x - floor.origin_x as f32;
    let local_from_z = from_z - rp.house_origin_z - floor.origin_z as f32;
    let local_to_x = to_x - rp.house_origin_x - floor.origin_x as f32;
    let local_to_z = to_z - rp.house_origin_z - floor.origin_z as f32;

    edge_blocks_axis(
        local_from_x,
        local_to_x,
        local_from_z,
        local_to_z,
        floor,
        true,
    ) || edge_blocks_axis(
        local_from_z,
        local_to_z,
        local_from_x,
        local_to_x,
        floor,
        false,
    )
}

/// Check if a circle of radius `r` at `(x, z)` overlaps any blocking wall edge
/// on `floor_level`. Enforces player thickness so the character stops short of
/// walls instead of embedding into them, and lets path smoothing reject
/// diagonals whose interior would clip a corner the body radius can't clear.
pub fn is_circle_blocked_on_floor(
    cache: &PassabilityCache,
    x: f32,
    z: f32,
    r: f32,
    floor_level: u8,
    y: Option<f32>,
) -> bool {
    for rp in cache.values() {
        if x + r < rp.min_x || x - r > rp.max_x || z + r < rp.min_z || z - r > rp.max_z {
            continue;
        }

        // Same two-floor rule the edge check uses. Each floor's grid seals the
        // stairwell end it does not own, and the body radius sits right on that
        // seal whenever the mover reaches that end — so a landing would wall
        // itself off from the floor keyed to the far end.
        let stair_mask = stairwell_floor_mask(rp, x - r, x + r, z - r, z + r, floor_level);
        if stair_mask != 0 {
            let mut connected = rp
                .floors
                .iter()
                .filter(|f| stair_mask & floor_bit(f.floor_level) != 0)
                .filter(|f| obstacle_reaches_y(f, y))
                .peekable();
            if connected.peek().is_some()
                && connected.all(|f| circle_blocked_on_grid(rp, f, x, z, r))
            {
                return true;
            }
            continue;
        }

        for floor in &rp.floors {
            if floor.floor_level == floor_level
                && obstacle_reaches_y(floor, y)
                && circle_blocked_on_grid(rp, floor, x, z, r)
            {
                return true;
            }
        }
    }
    false
}

/// Whether a circle at `(x, z)` clips a blocking edge on one specific grid.
fn circle_blocked_on_grid(
    rp: &super::RuntimePassability,
    floor: &RuntimeFloorGrid,
    x: f32,
    z: f32,
    r: f32,
) -> bool {
    let r2 = r * r;
    let local_x = x - rp.house_origin_x - floor.origin_x as f32;
    let local_z = z - rp.house_origin_z - floor.origin_z as f32;
    let w = floor.width as i32;
    let d = floor.depth as i32;
    let min_cx = ((local_x - r).floor() as i32).max(0);
    let max_cx = ((local_x + r).floor() as i32).min(w - 1);
    let min_cz = ((local_z - r).floor() as i32).max(0);
    let max_cz = ((local_z + r).floor() as i32).min(d - 1);
    for cz in min_cz..=max_cz {
        for cx in min_cx..=max_cx {
            let cell = floor.cells[(cx + cz * w) as usize];
            if cell == 0 {
                continue;
            }
            let cx_f = cx as f32;
            let cz_f = cz as f32;
            if cell & EDGE_N != 0 && unit_segment_dist_sq(local_x, local_z, cx_f, cz_f, true) < r2 {
                return true;
            }
            if cell & EDGE_S != 0
                && unit_segment_dist_sq(local_x, local_z, cx_f, cz_f + 1.0, true) < r2
            {
                return true;
            }
            if cell & EDGE_W != 0 && unit_segment_dist_sq(local_x, local_z, cx_f, cz_f, false) < r2
            {
                return true;
            }
            if cell & EDGE_E != 0
                && unit_segment_dist_sq(local_x, local_z, cx_f + 1.0, cz_f, false) < r2
            {
                return true;
            }
        }
    }
    false
}

/// Squared distance from point `(px, pz)` to a unit-length axis-aligned
/// segment starting at `(sx, sz)`. `along_x` selects whether the segment
/// extends in +X (a north/south wall) or +Z (a west/east wall).
#[inline]
fn unit_segment_dist_sq(px: f32, pz: f32, sx: f32, sz: f32, along_x: bool) -> f32 {
    if along_x {
        let cx = px.clamp(sx, sx + 1.0);
        let dx = px - cx;
        let dz = pz - sz;
        dx * dx + dz * dz
    } else {
        let cz = pz.clamp(sz, sz + 1.0);
        let dx = px - sx;
        let dz = pz - cz;
        dx * dx + dz * dz
    }
}

/// Check if any cell boundary crossing along one axis is blocked.
fn edge_blocks_axis(
    from_a: f32,
    to_a: f32,
    from_b: f32,
    to_b: f32,
    floor: &RuntimeFloorGrid,
    x_axis: bool,
) -> bool {
    let from_cell = from_a.floor() as i32;
    let to_cell = to_a.floor() as i32;
    if from_cell == to_cell {
        return false;
    }

    let size_a = if x_axis { floor.width } else { floor.depth } as i32;
    let size_b = if x_axis { floor.depth } else { floor.width } as i32;
    let w = floor.width as i32;
    let idx = |a: i32, b: i32| -> usize {
        if x_axis {
            (a + b * w) as usize
        } else {
            (b + a * w) as usize
        }
    };

    let step: i32 = if to_cell > from_cell { 1 } else { -1 };
    let (leave_bit, enter_bit) = match (x_axis, step > 0) {
        (true, true) => (EDGE_E, EDGE_W),
        (true, false) => (EDGE_W, EDGE_E),
        (false, true) => (EDGE_S, EDGE_N),
        (false, false) => (EDGE_N, EDGE_S),
    };

    // Loop-invariant: skip the whole sweep if the parametric denominator is
    // numerically zero (would otherwise produce NaN `t` values inside).
    let denom = to_a - from_a;
    if denom.abs() <= f32::EPSILON {
        return false;
    }
    let mut cell = from_cell;
    while cell != to_cell {
        let edge_coord = if step > 0 { cell + 1 } else { cell };
        let next_cell = cell + step;
        let t = (edge_coord as f32 - from_a) / denom;
        let cell_b = (from_b + t * (to_b - from_b)).floor() as i32;
        if cell_b >= 0 && cell_b < size_b {
            if cell >= 0 && cell < size_a && floor.cells[idx(cell, cell_b)] & leave_bit != 0 {
                return true;
            }
            if next_cell >= 0
                && next_cell < size_a
                && floor.cells[idx(next_cell, cell_b)] & enter_bit != 0
            {
                return true;
            }
        }
        cell += step;
    }
    false
}

/// Get the floor level at a world position based on Y height.
/// Returns 0 if outside any house.
/// Picks the floor whose y_base is closest to y among all floors whose
/// grid contains the cell — handles mid-stairwell clicks and overlapping
/// floor ranges at stairwell landings.
pub fn get_floor_at_position(cache: &PassabilityCache, x: f32, z: f32, y: f32) -> u8 {
    let cx = x.floor() as i32;
    let cz = z.floor() as i32;
    let mut best_floor: u8 = 0;
    let mut best_dist = f32::INFINITY;
    let mut found = false;

    for rp in cache.values() {
        if x < rp.min_x || x > rp.max_x || z < rp.min_z || z > rp.max_z {
            continue;
        }
        let house_ox = rp.house_origin_x.floor() as i32;
        let house_oz = rp.house_origin_z.floor() as i32;
        for floor in &rp.floors {
            let gx = cx - house_ox - floor.origin_x;
            let gz = cz - house_oz - floor.origin_z;
            if gx < 0 || gx >= floor.width as i32 || gz < 0 || gz >= floor.depth as i32 {
                continue;
            }
            // Cell is inside this floor's grid — pick the closest y_base
            let dist = (y - floor.y_base).abs();
            if dist < best_dist {
                best_dist = dist;
                best_floor = floor.floor_level;
                found = true;
            }
        }
    }

    if found {
        best_floor
    } else {
        0
    }
}

/// Get the yBase for a given floor level at a world position.
pub fn get_floor_y_base(cache: &PassabilityCache, x: f32, z: f32, floor_level: u8) -> Option<f32> {
    let cx = x.floor() as i32;
    let cz = z.floor() as i32;
    for rp in cache.values() {
        if x < rp.min_x || x > rp.max_x || z < rp.min_z || z > rp.max_z {
            continue;
        }
        let house_ox = rp.house_origin_x.floor() as i32;
        let house_oz = rp.house_origin_z.floor() as i32;
        for floor in &rp.floors {
            if floor.floor_level != floor_level {
                continue;
            }
            let gx = cx - house_ox - floor.origin_x;
            let gz = cz - house_oz - floor.origin_z;
            if gx >= 0 && gx < floor.width as i32 && gz >= 0 && gz < floor.depth as i32 {
                return Some(floor.y_base);
            }
        }
    }
    None
}
