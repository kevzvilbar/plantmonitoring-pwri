import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAppStore } from '@/store/appStore';

export interface Plant {
  id: string;
  name: string;
  status: 'Active' | 'Inactive';
  design_capacity_m3: number | null;
  num_ro_trains: number;
  address: string | null;
  gps_lat: number | null;
  gps_lng: number | null;
  geofence_radius_m: number;
  backwash_mode: 'independent' | 'synchronized';
  /** added 20260427 — energy meter integration */
  has_solar?: boolean;
  has_grid?: boolean;
  solar_capacity_kw?: number | null;
}

export function usePlants() {
  return useQuery({
    queryKey: ['plants'],
    queryFn: async () => {
      const { data, error } = await supabase.from('plants').select('*').order('name');
      if (error) throw error;
      return (data ?? []) as Plant[];
    },
  });
}

/** Plants visible to the current user, filtered by global plant filter */
export function useFilteredPlants() {
  const { selectedPlantId } = useAppStore();
  const { data, ...rest } = usePlants();
  const filtered = selectedPlantId ? data?.filter((p) => p.id === selectedPlantId) : data;
  return { data: filtered, allPlants: data, ...rest };
}
