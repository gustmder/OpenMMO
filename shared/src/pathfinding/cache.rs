//! Build and mutate the runtime passability cache. The cache is keyed by
//! house id and stores per-floor cell grids (with edge-bitmask occupancy)
//! plus stairwell metadata. Built once per house from `HouseData`, then
//! mutated via `update_door_edge` whenever a door opens or closes.

use crate::housing::{HouseData, RoomData, RoomType, WallDirection, WallVariant};

use super::{
    PassabilityCache, RuntimeFloorGrid, RuntimePassability, StairwellInfo, EDGE_E, EDGE_N, EDGE_S,
    EDGE_W,
};

const FLOOR_THICKNESS: f32 = 0.1;
const DEFAULT_WALL_HEIGHT: f32 = 3.0;

#[inline]
fn floor_y_base(floor_level: u8, wall_height: f32) -> f32 {
    floor_level as f32 * (wall_height + FLOOR_THICKNESS)
}

/// Build runtime passability data from a HouseData.
/// Expects pre-computed PassabilityGrid in house.passability.
/// The caller must ensure passability is computed before calling this.
pub fn build_runtime_passability(house: &HouseData) -> RuntimePassability {
    let grids = &house.passability;

    let mut min_x = f32::INFINITY;
    let mut max_x = f32::NEG_INFINITY;
    let mut min_z = f32::INFINITY;
    let mut max_z = f32::NEG_INFINITY;

    let floors: Vec<RuntimeFloorGrid> = grids
        .iter()
        .map(|g| {
            let world_min_x = house.origin.x + g.origin_x as f32;
            let world_min_z = house.origin.z + g.origin_z as f32;
            let world_max_x = world_min_x + g.width as f32;
            let world_max_z = world_min_z + g.depth as f32;
            min_x = min_x.min(world_min_x);
            max_x = max_x.max(world_max_x);
            min_z = min_z.min(world_min_z);
            max_z = max_z.max(world_max_z);

            let mut wall_height = DEFAULT_WALL_HEIGHT;
            let mut y_base = house.origin.y;
            for room in &house.rooms {
                if room.floor_level == g.floor_level {
                    wall_height = room.wall_height;
                    y_base = house.origin.y + floor_y_base(room.floor_level, room.wall_height);
                    break;
                }
                if room.room_type == RoomType::Stairwell && g.floor_level == room.floor_level + 1 {
                    wall_height = room.wall_height;
                    y_base = house.origin.y + floor_y_base(g.floor_level, room.wall_height);
                    break;
                }
            }

            RuntimeFloorGrid {
                floor_level: g.floor_level,
                origin_x: g.origin_x,
                origin_z: g.origin_z,
                width: g.width,
                depth: g.depth,
                y_base,
                wall_height,
                cells: g.cells.clone(),
            }
        })
        .collect();

    let mut stairwells = Vec::new();
    for room in &house.rooms {
        if room.room_type == RoomType::Stairwell {
            stairwells.push(StairwellInfo {
                local_min_x: room.local_x,
                local_min_z: room.local_z,
                local_max_x: room.local_x + room.size_x as i32,
                local_max_z: room.local_z + room.size_z as i32,
                lower_floor: room.floor_level,
                upper_floor: room.floor_level + 1,
                along_z: room.size_z as i32 >= room.size_x as i32,
                reversed: room.stair_reversed,
            });
        }
    }

    RuntimePassability {
        house_origin_x: house.origin.x,
        house_origin_z: house.origin.z,
        min_x,
        max_x,
        min_z,
        max_z,
        floors,
        stairwells,
    }
}

/// Update passability edge bits when a door is opened or closed.
pub fn update_door_edge(
    cache: &mut PassabilityCache,
    house_id: &str,
    room: &RoomData,
    wall_dir: WallDirection,
    segment_index: usize,
    is_open: bool,
) {
    let rp = match cache.get_mut(house_id) {
        Some(rp) => rp,
        None => return,
    };

    let floor = match rp
        .floors
        .iter_mut()
        .find(|f| f.floor_level == room.floor_level)
    {
        Some(f) => f,
        None => return,
    };

    let rx = room.local_x - floor.origin_x;
    let rz = room.local_z - floor.origin_z;

    let (cx, cz, edge, adj_cx, adj_cz, adj_edge) = match wall_dir {
        WallDirection::North => {
            let cx = rx + segment_index as i32;
            (cx, rz, EDGE_N, cx, rz - 1, EDGE_S)
        }
        WallDirection::South => {
            let cx = rx + segment_index as i32;
            let cz = rz + room.size_z as i32 - 1;
            (cx, cz, EDGE_S, cx, cz + 1, EDGE_N)
        }
        WallDirection::West => {
            let cz = rz + segment_index as i32;
            (rx, cz, EDGE_W, rx - 1, cz, EDGE_E)
        }
        WallDirection::East => {
            let cx = rx + room.size_x as i32 - 1;
            let cz = rz + segment_index as i32;
            (cx, cz, EDGE_E, cx + 1, cz, EDGE_W)
        }
    };

    let w = floor.width as i32;
    let d = floor.depth as i32;

    let set_or_clear = |cells: &mut Vec<u8>, gx: i32, gz: i32, bit: u8| {
        if gx < 0 || gx >= w || gz < 0 || gz >= d {
            return;
        }
        let idx = (gx + gz * w) as usize;
        if is_open {
            cells[idx] &= !bit;
        } else {
            cells[idx] |= bit;
        }
    };

    set_or_clear(&mut floor.cells, cx, cz, edge);
    set_or_clear(&mut floor.cells, adj_cx, adj_cz, adj_edge);
}

/// Apply open-door overlays from a HouseData to its runtime passability cache entry.
/// Should be called after build_runtime_passability to reflect doors that are already open.
pub fn apply_door_overlays(cache: &mut PassabilityCache, house: &HouseData) {
    for room in &house.rooms {
        for (dir, segs) in [
            (WallDirection::North, &room.wall_north),
            (WallDirection::South, &room.wall_south),
            (WallDirection::East, &room.wall_east),
            (WallDirection::West, &room.wall_west),
        ] {
            for (i, seg) in segs.iter().enumerate() {
                if seg.variant == WallVariant::WithDoor && seg.is_open {
                    update_door_edge(cache, &house.id, room, dir, i, true);
                }
            }
        }
    }
}
