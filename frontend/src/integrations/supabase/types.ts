export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      afm_readings: {
        Row: {
          afm_unit_number: number
          backwash_end: string | null
          backwash_start: string | null
          backwash_volume: number | null
          created_at: string
          dp_psi: number | null
          id: string
          inlet_pressure_psi: number | null
          meter_final: number | null
          meter_initial: number | null
          mode: string
          outlet_pressure_psi: number | null
          plant_id: string
          reading_datetime: string
          recorded_by: string | null
          train_id: string
        }
        Insert: {
          afm_unit_number: number
          backwash_end?: string | null
          backwash_start?: string | null
          backwash_volume?: number | null
          created_at?: string
          dp_psi?: number | null
          id?: string
          inlet_pressure_psi?: number | null
          meter_final?: number | null
          meter_initial?: number | null
          mode?: string
          outlet_pressure_psi?: number | null
          plant_id: string
          reading_datetime?: string
          recorded_by?: string | null
          train_id: string
        }
        Update: {
          afm_unit_number?: number
          backwash_end?: string | null
          backwash_start?: string | null
          backwash_volume?: number | null
          created_at?: string
          dp_psi?: number | null
          id?: string
          inlet_pressure_psi?: number | null
          meter_final?: number | null
          meter_initial?: number | null
          mode?: string
          outlet_pressure_psi?: number | null
          plant_id?: string
          reading_datetime?: string
          recorded_by?: string | null
          train_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "afm_readings_plant_id_fkey"
            columns: ["plant_id"]
            isOneToOne: false
            referencedRelation: "plants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "afm_readings_recorded_by_fkey"
            columns: ["recorded_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "afm_readings_train_id_fkey"
            columns: ["train_id"]
            isOneToOne: false
            referencedRelation: "ro_trains"
            referencedColumns: ["id"]
          },
        ]
      }
      cartridge_readings: {
        Row: {
          bag_replaced: boolean
          cartridge_number: number
          created_at: string
          dp_psi: number | null
          id: string
          inlet_pressure_psi: number | null
          outlet_pressure_psi: number | null
          pieces_replaced: number | null
          plant_id: string
          reading_datetime: string
          recorded_by: string | null
          train_id: string
        }
        Insert: {
          bag_replaced?: boolean
          cartridge_number: number
          created_at?: string
          dp_psi?: number | null
          id?: string
          inlet_pressure_psi?: number | null
          outlet_pressure_psi?: number | null
          pieces_replaced?: number | null
          plant_id: string
          reading_datetime?: string
          recorded_by?: string | null
          train_id: string
        }
        Update: {
          bag_replaced?: boolean
          cartridge_number?: number
          created_at?: string
          dp_psi?: number | null
          id?: string
          inlet_pressure_psi?: number | null
          outlet_pressure_psi?: number | null
          pieces_replaced?: number | null
          plant_id?: string
          reading_datetime?: string
          recorded_by?: string | null
          train_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "cartridge_readings_plant_id_fkey"
            columns: ["plant_id"]
            isOneToOne: false
            referencedRelation: "plants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cartridge_readings_recorded_by_fkey"
            columns: ["recorded_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cartridge_readings_train_id_fkey"
            columns: ["train_id"]
            isOneToOne: false
            referencedRelation: "ro_trains"
            referencedColumns: ["id"]
          },
        ]
      }
      checklist_executions: {
        Row: {
          completed: boolean
          completed_at: string | null
          completed_by: string | null
          created_at: string
          execution_date: string
          findings: string | null
          frequency: Database["public"]["Enums"]["frequency_type"] | null
          id: string
          plant_id: string | null
          template_id: string
        }
        Insert: {
          completed?: boolean
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          execution_date?: string
          findings?: string | null
          frequency?: Database["public"]["Enums"]["frequency_type"] | null
          id?: string
          plant_id?: string | null
          template_id: string
        }
        Update: {
          completed?: boolean
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          execution_date?: string
          findings?: string | null
          frequency?: Database["public"]["Enums"]["frequency_type"] | null
          id?: string
          plant_id?: string | null
          template_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "checklist_executions_completed_by_fkey"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "checklist_executions_plant_id_fkey"
            columns: ["plant_id"]
            isOneToOne: false
            referencedRelation: "plants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "checklist_executions_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "checklist_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      checklist_step_executions: {
        Row: {
          completed: boolean
          completed_at: string | null
          completed_by: string | null
          created_at: string
          execution_id: string
          id: string
          notes: string | null
          plant_id: string | null
          step_index: number
          step_text: string
          template_id: string
          value: string | null
        }
        Insert: {
          completed?: boolean
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          execution_id: string
          id?: string
          notes?: string | null
          plant_id?: string | null
          step_index: number
          step_text: string
          template_id: string
          value?: string | null
        }
        Update: {
          completed?: boolean
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          execution_id?: string
          id?: string
          notes?: string | null
          plant_id?: string | null
          step_index?: number
          step_text?: string
          template_id?: string
          value?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "checklist_step_executions_completed_by_fkey"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "checklist_step_executions_execution_id_fkey"
            columns: ["execution_id"]
            isOneToOne: false
            referencedRelation: "checklist_executions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "checklist_step_executions_plant_id_fkey"
            columns: ["plant_id"]
            isOneToOne: false
            referencedRelation: "plants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "checklist_step_executions_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "checklist_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      checklist_templates: {
        Row: {
          category: string
          checklist_steps: string[] | null
          created_at: string
          created_by: string | null
          equipment_name: string
          frequency: Database["public"]["Enums"]["frequency_type"]
          id: string
          plant_id: string | null
          schedule_start_date: string | null
        }
        Insert: {
          category: string
          checklist_steps?: string[] | null
          created_at?: string
          created_by?: string | null
          equipment_name: string
          frequency: Database["public"]["Enums"]["frequency_type"]
          id?: string
          plant_id?: string | null
          schedule_start_date?: string | null
        }
        Update: {
          category?: string
          checklist_steps?: string[] | null
          created_at?: string
          created_by?: string | null
          equipment_name?: string
          frequency?: Database["public"]["Enums"]["frequency_type"]
          id?: string
          plant_id?: string | null
          schedule_start_date?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "checklist_templates_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "checklist_templates_plant_id_fkey"
            columns: ["plant_id"]
            isOneToOne: false
            referencedRelation: "plants"
            referencedColumns: ["id"]
          },
        ]
      }
      chemical_deliveries: {
        Row: {
          chemical_name: string
          created_at: string
          delivery_date: string
          id: string
          plant_id: string
          quantity: number
          recorded_by: string | null
          remarks: string | null
          supplier: string | null
          unit: string
          unit_cost: number | null
        }
        Insert: {
          chemical_name: string
          created_at?: string
          delivery_date?: string
          id?: string
          plant_id: string
          quantity: number
          recorded_by?: string | null
          remarks?: string | null
          supplier?: string | null
          unit?: string
          unit_cost?: number | null
        }
        Update: {
          chemical_name?: string
          created_at?: string
          delivery_date?: string
          id?: string
          plant_id?: string
          quantity?: number
          recorded_by?: string | null
          remarks?: string | null
          supplier?: string | null
          unit?: string
          unit_cost?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "chemical_deliveries_plant_id_fkey"
            columns: ["plant_id"]
            isOneToOne: false
            referencedRelation: "plants"
            referencedColumns: ["id"]
          },
        ]
      }
      chemical_dosing_logs: {
        Row: {
          anti_scalant_l: number
          calculated_cost: number | null
          chlorine_kg: number
          created_at: string
          free_chlorine_reagent_pcs: number
          id: string
          log_datetime: string
          plant_id: string
          product_water_free_cl_ppm: number | null
          recorded_by: string | null
          smbs_kg: number
          soda_ash_kg: number
        }
        Insert: {
          anti_scalant_l?: number
          calculated_cost?: number | null
          chlorine_kg?: number
          created_at?: string
          free_chlorine_reagent_pcs?: number
          id?: string
          log_datetime?: string
          plant_id: string
          product_water_free_cl_ppm?: number | null
          recorded_by?: string | null
          smbs_kg?: number
          soda_ash_kg?: number
        }
        Update: {
          anti_scalant_l?: number
          calculated_cost?: number | null
          chlorine_kg?: number
          created_at?: string
          free_chlorine_reagent_pcs?: number
          id?: string
          log_datetime?: string
          plant_id?: string
          product_water_free_cl_ppm?: number | null
          recorded_by?: string | null
          smbs_kg?: number
          soda_ash_kg?: number
        }
        Relationships: [
          {
            foreignKeyName: "chemical_dosing_logs_plant_id_fkey"
            columns: ["plant_id"]
            isOneToOne: false
            referencedRelation: "plants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chemical_dosing_logs_recorded_by_fkey"
            columns: ["recorded_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      chemical_inventory: {
        Row: {
          chemical_name: string
          current_stock: number
          id: string
          low_stock_threshold: number
          plant_id: string
          price_per_unit: number | null
          unit: string | null
          unit_type: string | null
          updated_at: string
        }
        Insert: {
          chemical_name: string
          current_stock?: number
          id?: string
          low_stock_threshold?: number
          plant_id: string
          price_per_unit?: number | null
          unit?: string | null
          unit_type?: string | null
          updated_at?: string
        }
        Update: {
          chemical_name?: string
          current_stock?: number
          id?: string
          low_stock_threshold?: number
          plant_id?: string
          price_per_unit?: number | null
          unit?: string | null
          unit_type?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "chemical_inventory_plant_id_fkey"
            columns: ["plant_id"]
            isOneToOne: false
            referencedRelation: "plants"
            referencedColumns: ["id"]
          },
        ]
      }
      chemical_prices: {
        Row: {
          chemical_name: string
          created_at: string
          effective_date: string
          id: string
          unit_price: number
          updated_by: string | null
        }
        Insert: {
          chemical_name: string
          created_at?: string
          effective_date: string
          id?: string
          unit_price: number
          updated_by?: string | null
        }
        Update: {
          chemical_name?: string
          created_at?: string
          effective_date?: string
          id?: string
          unit_price?: number
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "chemical_prices_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      chemical_residual_samples: {
        Row: {
          created_at: string
          dosing_log_id: string
          id: string
          plant_id: string
          residual_ppm: number | null
          sample_index: number
          sampling_point: string | null
        }
        Insert: {
          created_at?: string
          dosing_log_id: string
          id?: string
          plant_id: string
          residual_ppm?: number | null
          sample_index: number
          sampling_point?: string | null
        }
        Update: {
          created_at?: string
          dosing_log_id?: string
          id?: string
          plant_id?: string
          residual_ppm?: number | null
          sample_index?: number
          sampling_point?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "chemical_residual_samples_dosing_log_id_fkey"
            columns: ["dosing_log_id"]
            isOneToOne: false
            referencedRelation: "chemical_dosing_logs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chemical_residual_samples_plant_id_fkey"
            columns: ["plant_id"]
            isOneToOne: false
            referencedRelation: "plants"
            referencedColumns: ["id"]
          },
        ]
      }
      cip_logs: {
        Row: {
          caustic_soda_kg: number | null
          conducted_by: string | null
          created_at: string
          end_datetime: string | null
          hcl_l: number | null
          id: string
          plant_id: string
          remarks: string | null
          sls_g: number | null
          start_datetime: string | null
          train_id: string
        }
        Insert: {
          caustic_soda_kg?: number | null
          conducted_by?: string | null
          created_at?: string
          end_datetime?: string | null
          hcl_l?: number | null
          id?: string
          plant_id: string
          remarks?: string | null
          sls_g?: number | null
          start_datetime?: string | null
          train_id: string
        }
        Update: {
          caustic_soda_kg?: number | null
          conducted_by?: string | null
          created_at?: string
          end_datetime?: string | null
          hcl_l?: number | null
          id?: string
          plant_id?: string
          remarks?: string | null
          sls_g?: number | null
          start_datetime?: string | null
          train_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "cip_logs_conducted_by_fkey"
            columns: ["conducted_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cip_logs_plant_id_fkey"
            columns: ["plant_id"]
            isOneToOne: false
            referencedRelation: "plants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cip_logs_train_id_fkey"
            columns: ["train_id"]
            isOneToOne: false
            referencedRelation: "ro_trains"
            referencedColumns: ["id"]
          },
        ]
      }
      daily_plant_summary: {
        Row: {
          blending_m3: number | null
          created_at: string
          downtime_hrs: number | null
          feed_pressure_psi: number | null
          feed_tds: number | null
          id: string
          locator_consumption_m3: number | null
          notes: string | null
          permeate_tds: number | null
          plant_id: string
          power_kwh: number | null
          product_tds: number | null
          production_m3: number | null
          pv_ratio: number | null
          raw_turbidity_ntu: number | null
          raw_water_consumption_m3: number | null
          recovery_pct: number | null
          reject_pressure_psi: number | null
          reject_tds: number | null
          rejection_pct: number | null
          source: string | null
          summary_date: string
          updated_at: string
        }
        Insert: {
          blending_m3?: number | null
          created_at?: string
          downtime_hrs?: number | null
          feed_pressure_psi?: number | null
          feed_tds?: number | null
          id?: string
          locator_consumption_m3?: number | null
          notes?: string | null
          permeate_tds?: number | null
          plant_id: string
          power_kwh?: number | null
          product_tds?: number | null
          production_m3?: number | null
          pv_ratio?: number | null
          raw_turbidity_ntu?: number | null
          raw_water_consumption_m3?: number | null
          recovery_pct?: number | null
          reject_pressure_psi?: number | null
          reject_tds?: number | null
          rejection_pct?: number | null
          source?: string | null
          summary_date: string
          updated_at?: string
        }
        Update: {
          blending_m3?: number | null
          created_at?: string
          downtime_hrs?: number | null
          feed_pressure_psi?: number | null
          feed_tds?: number | null
          id?: string
          locator_consumption_m3?: number | null
          notes?: string | null
          permeate_tds?: number | null
          plant_id?: string
          power_kwh?: number | null
          product_tds?: number | null
          production_m3?: number | null
          pv_ratio?: number | null
          raw_turbidity_ntu?: number | null
          raw_water_consumption_m3?: number | null
          recovery_pct?: number | null
          reject_pressure_psi?: number | null
          reject_tds?: number | null
          rejection_pct?: number | null
          source?: string | null
          summary_date?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "daily_plant_summary_plant_id_fkey"
            columns: ["plant_id"]
            isOneToOne: false
            referencedRelation: "plants"
            referencedColumns: ["id"]
          },
        ]
      }
      downtime_events: {
        Row: {
          addressed: boolean
          cause: string
          created_at: string
          duration_hrs: number
          event_date: string
          id: string
          notes: string | null
          plant_id: string
          recorded_by: string | null
          resolution: string | null
          updated_at: string
        }
        Insert: {
          addressed?: boolean
          cause: string
          created_at?: string
          duration_hrs?: number
          event_date?: string
          id?: string
          notes?: string | null
          plant_id: string
          recorded_by?: string | null
          resolution?: string | null
          updated_at?: string
        }
        Update: {
          addressed?: boolean
          cause?: string
          created_at?: string
          duration_hrs?: number
          event_date?: string
          id?: string
          notes?: string | null
          plant_id?: string
          recorded_by?: string | null
          resolution?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "downtime_events_plant_id_fkey"
            columns: ["plant_id"]
            isOneToOne: false
            referencedRelation: "plants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "downtime_events_recorded_by_fkey"
            columns: ["recorded_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      electric_bills: {
        Row: {
          billing_month: string
          created_at: string
          current_reading: number
          distribution_charge: number | null
          generation_charge: number | null
          id: string
          multiplier: number
          other_charges: number | null
          period_end: string
          period_start: string
          plant_id: string
          previous_reading: number
          recorded_by: string | null
          remarks: string | null
          total_amount: number
          total_kwh: number | null
          updated_at: string
        }
        Insert: {
          billing_month: string
          created_at?: string
          current_reading: number
          distribution_charge?: number | null
          generation_charge?: number | null
          id?: string
          multiplier?: number
          other_charges?: number | null
          period_end: string
          period_start: string
          plant_id: string
          previous_reading: number
          recorded_by?: string | null
          remarks?: string | null
          total_amount: number
          total_kwh?: number | null
          updated_at?: string
        }
        Update: {
          billing_month?: string
          created_at?: string
          current_reading?: number
          distribution_charge?: number | null
          generation_charge?: number | null
          id?: string
          multiplier?: number
          other_charges?: number | null
          period_end?: string
          period_start?: string
          plant_id?: string
          previous_reading?: number
          recorded_by?: string | null
          remarks?: string | null
          total_amount?: number
          total_kwh?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "electric_bills_plant_id_fkey"
            columns: ["plant_id"]
            isOneToOne: false
            referencedRelation: "plants"
            referencedColumns: ["id"]
          },
        ]
      }
      incidents: {
        Row: {
          closed_at: string | null
          closed_by: string | null
          corrective_action: string | null
          created_at: string
          gps_lat: number | null
          gps_lng: number | null
          id: string
          immediate_action: string | null
          incident_ref: string | null
          incident_type: string | null
          photo_url: string | null
          plant_id: string
          preventive_measures: string | null
          resolved_at: string | null
          resolved_by: string | null
          root_cause: string | null
          severity: Database["public"]["Enums"]["severity_level"] | null
          status: Database["public"]["Enums"]["incident_status"]
          temperature_c: number | null
          updated_at: string
          weather: string | null
          what_description: string | null
          when_datetime: string | null
          where_location: string | null
          who_reporter: string | null
          witness: string | null
        }
        Insert: {
          closed_at?: string | null
          closed_by?: string | null
          corrective_action?: string | null
          created_at?: string
          gps_lat?: number | null
          gps_lng?: number | null
          id?: string
          immediate_action?: string | null
          incident_ref?: string | null
          incident_type?: string | null
          photo_url?: string | null
          plant_id: string
          preventive_measures?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          root_cause?: string | null
          severity?: Database["public"]["Enums"]["severity_level"] | null
          status?: Database["public"]["Enums"]["incident_status"]
          temperature_c?: number | null
          updated_at?: string
          weather?: string | null
          what_description?: string | null
          when_datetime?: string | null
          where_location?: string | null
          who_reporter?: string | null
          witness?: string | null
        }
        Update: {
          closed_at?: string | null
          closed_by?: string | null
          corrective_action?: string | null
          created_at?: string
          gps_lat?: number | null
          gps_lng?: number | null
          id?: string
          immediate_action?: string | null
          incident_ref?: string | null
          incident_type?: string | null
          photo_url?: string | null
          plant_id?: string
          preventive_measures?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          root_cause?: string | null
          severity?: Database["public"]["Enums"]["severity_level"] | null
          status?: Database["public"]["Enums"]["incident_status"]
          temperature_c?: number | null
          updated_at?: string
          weather?: string | null
          what_description?: string | null
          when_datetime?: string | null
          where_location?: string | null
          who_reporter?: string | null
          witness?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "incidents_closed_by_fkey"
            columns: ["closed_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "incidents_plant_id_fkey"
            columns: ["plant_id"]
            isOneToOne: false
            referencedRelation: "plants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "incidents_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "incidents_who_reporter_fkey"
            columns: ["who_reporter"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      locator_meter_replacements: {
        Row: {
          created_at: string
          id: string
          locator_id: string
          new_meter_brand: string | null
          new_meter_initial_reading: number | null
          new_meter_installed_date: string | null
          new_meter_serial: string | null
          new_meter_size: string | null
          old_meter_brand: string | null
          old_meter_final_reading: number | null
          old_meter_serial: string | null
          old_meter_size: string | null
          plant_id: string
          remarks: string | null
          replaced_by: string | null
          replacement_date: string
        }
        Insert: {
          created_at?: string
          id?: string
          locator_id: string
          new_meter_brand?: string | null
          new_meter_initial_reading?: number | null
          new_meter_installed_date?: string | null
          new_meter_serial?: string | null
          new_meter_size?: string | null
          old_meter_brand?: string | null
          old_meter_final_reading?: number | null
          old_meter_serial?: string | null
          old_meter_size?: string | null
          plant_id: string
          remarks?: string | null
          replaced_by?: string | null
          replacement_date: string
        }
        Update: {
          created_at?: string
          id?: string
          locator_id?: string
          new_meter_brand?: string | null
          new_meter_initial_reading?: number | null
          new_meter_installed_date?: string | null
          new_meter_serial?: string | null
          new_meter_size?: string | null
          old_meter_brand?: string | null
          old_meter_final_reading?: number | null
          old_meter_serial?: string | null
          old_meter_size?: string | null
          plant_id?: string
          remarks?: string | null
          replaced_by?: string | null
          replacement_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "locator_meter_replacements_locator_id_fkey"
            columns: ["locator_id"]
            isOneToOne: false
            referencedRelation: "locators"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "locator_meter_replacements_plant_id_fkey"
            columns: ["plant_id"]
            isOneToOne: false
            referencedRelation: "plants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "locator_meter_replacements_replaced_by_fkey"
            columns: ["replaced_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      locator_readings: {
        Row: {
          created_at: string
          current_reading: number
          daily_volume: number | null
          gps_lat: number | null
          gps_lng: number | null
          id: string
          locator_id: string
          off_location_flag: boolean
          plant_id: string
          previous_reading: number | null
          reading_datetime: string
          recorded_by: string | null
          remarks: string | null
        }
        Insert: {
          created_at?: string
          current_reading: number
          daily_volume?: number | null
          gps_lat?: number | null
          gps_lng?: number | null
          id?: string
          locator_id: string
          off_location_flag?: boolean
          plant_id: string
          previous_reading?: number | null
          reading_datetime?: string
          recorded_by?: string | null
          remarks?: string | null
        }
        Update: {
          created_at?: string
          current_reading?: number
          daily_volume?: number | null
          gps_lat?: number | null
          gps_lng?: number | null
          id?: string
          locator_id?: string
          off_location_flag?: boolean
          plant_id?: string
          previous_reading?: number | null
          reading_datetime?: string
          recorded_by?: string | null
          remarks?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "locator_readings_locator_id_fkey"
            columns: ["locator_id"]
            isOneToOne: false
            referencedRelation: "locators"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "locator_readings_plant_id_fkey"
            columns: ["plant_id"]
            isOneToOne: false
            referencedRelation: "plants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "locator_readings_recorded_by_fkey"
            columns: ["recorded_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      locators: {
        Row: {
          address: string | null
          created_at: string
          gps_lat: number | null
          gps_lng: number | null
          id: string
          location_desc: string | null
          meter_brand: string | null
          meter_installed_date: string | null
          meter_serial: string | null
          meter_size: string | null
          name: string
          plant_id: string
          status: Database["public"]["Enums"]["plant_status"]
          updated_at: string
        }
        Insert: {
          address?: string | null
          created_at?: string
          gps_lat?: number | null
          gps_lng?: number | null
          id?: string
          location_desc?: string | null
          meter_brand?: string | null
          meter_installed_date?: string | null
          meter_serial?: string | null
          meter_size?: string | null
          name: string
          plant_id: string
          status?: Database["public"]["Enums"]["plant_status"]
          updated_at?: string
        }
        Update: {
          address?: string | null
          created_at?: string
          gps_lat?: number | null
          gps_lng?: number | null
          id?: string
          location_desc?: string | null
          meter_brand?: string | null
          meter_installed_date?: string | null
          meter_serial?: string | null
          meter_size?: string | null
          name?: string
          plant_id?: string
          status?: Database["public"]["Enums"]["plant_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "locators_plant_id_fkey"
            columns: ["plant_id"]
            isOneToOne: false
            referencedRelation: "plants"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          alert_type: string
          created_at: string
          id: string
          link_path: string | null
          message: string | null
          plant_id: string | null
          read: boolean
          severity: Database["public"]["Enums"]["severity_level"]
          title: string
          user_id: string
        }
        Insert: {
          alert_type: string
          created_at?: string
          id?: string
          link_path?: string | null
          message?: string | null
          plant_id?: string | null
          read?: boolean
          severity?: Database["public"]["Enums"]["severity_level"]
          title: string
          user_id: string
        }
        Update: {
          alert_type?: string
          created_at?: string
          id?: string
          link_path?: string | null
          message?: string | null
          plant_id?: string | null
          read?: boolean
          severity?: Database["public"]["Enums"]["severity_level"]
          title?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_plant_id_fkey"
            columns: ["plant_id"]
            isOneToOne: false
            referencedRelation: "plants"
            referencedColumns: ["id"]
          },
        ]
      }
      plants: {
        Row: {
          address: string | null
          backwash_mode: string
          created_at: string
          design_capacity_m3: number | null
          geofence_radius_m: number
          gps_lat: number | null
          gps_lng: number | null
          id: string
          name: string
          num_ro_trains: number
          status: Database["public"]["Enums"]["plant_status"]
          updated_at: string
        }
        Insert: {
          address?: string | null
          backwash_mode?: string
          created_at?: string
          design_capacity_m3?: number | null
          geofence_radius_m?: number
          gps_lat?: number | null
          gps_lng?: number | null
          id?: string
          name: string
          num_ro_trains?: number
          status?: Database["public"]["Enums"]["plant_status"]
          updated_at?: string
        }
        Update: {
          address?: string | null
          backwash_mode?: string
          created_at?: string
          design_capacity_m3?: number | null
          geofence_radius_m?: number
          gps_lat?: number | null
          gps_lng?: number | null
          id?: string
          name?: string
          num_ro_trains?: number
          status?: Database["public"]["Enums"]["plant_status"]
          updated_at?: string
        }
        Relationships: []
      }
      power_readings: {
        Row: {
          created_at: string
          daily_consumption_kwh: number | null
          id: string
          meter_reading_kwh: number
          plant_id: string
          reading_datetime: string
          recorded_by: string | null
        }
        Insert: {
          created_at?: string
          daily_consumption_kwh?: number | null
          id?: string
          meter_reading_kwh: number
          plant_id: string
          reading_datetime?: string
          recorded_by?: string | null
        }
        Update: {
          created_at?: string
          daily_consumption_kwh?: number | null
          id?: string
          meter_reading_kwh?: number
          plant_id?: string
          reading_datetime?: string
          recorded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "power_readings_plant_id_fkey"
            columns: ["plant_id"]
            isOneToOne: false
            referencedRelation: "plants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "power_readings_recorded_by_fkey"
            columns: ["recorded_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      power_tariffs: {
        Row: {
          created_at: string
          created_by: string | null
          effective_date: string
          id: string
          multiplier: number
          plant_id: string
          provider: string | null
          rate_per_kwh: number
          remarks: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          effective_date: string
          id?: string
          multiplier?: number
          plant_id: string
          provider?: string | null
          rate_per_kwh: number
          remarks?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          effective_date?: string
          id?: string
          multiplier?: number
          plant_id?: string
          provider?: string | null
          rate_per_kwh?: number
          remarks?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "power_tariffs_plant_id_fkey"
            columns: ["plant_id"]
            isOneToOne: false
            referencedRelation: "plants"
            referencedColumns: ["id"]
          },
        ]
      }
      production_costs: {
        Row: {
          chem_cost: number
          cost_date: string
          cost_per_m3: number | null
          driver_notes: string | null
          id: string
          plant_id: string
          power_cost: number
          production_m3: number
          total_cost: number | null
          updated_at: string
        }
        Insert: {
          chem_cost?: number
          cost_date: string
          cost_per_m3?: number | null
          driver_notes?: string | null
          id?: string
          plant_id: string
          power_cost?: number
          production_m3?: number
          total_cost?: number | null
          updated_at?: string
        }
        Update: {
          chem_cost?: number
          cost_date?: string
          cost_per_m3?: number | null
          driver_notes?: string | null
          id?: string
          plant_id?: string
          power_cost?: number
          production_m3?: number
          total_cost?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "production_costs_plant_id_fkey"
            columns: ["plant_id"]
            isOneToOne: false
            referencedRelation: "plants"
            referencedColumns: ["id"]
          },
        ]
      }
      pump_readings: {
        Row: {
          created_at: string
          id: string
          l1_amp: number | null
          l2_amp: number | null
          l3_amp: number | null
          plant_id: string
          pump_number: number
          pump_type: string
          reading_datetime: string
          recorded_by: string | null
          target_pressure_psi: number | null
          train_id: string
          voltage: number | null
        }
        Insert: {
          created_at?: string
          id?: string
          l1_amp?: number | null
          l2_amp?: number | null
          l3_amp?: number | null
          plant_id: string
          pump_number: number
          pump_type: string
          reading_datetime?: string
          recorded_by?: string | null
          target_pressure_psi?: number | null
          train_id: string
          voltage?: number | null
        }
        Update: {
          created_at?: string
          id?: string
          l1_amp?: number | null
          l2_amp?: number | null
          l3_amp?: number | null
          plant_id?: string
          pump_number?: number
          pump_type?: string
          reading_datetime?: string
          recorded_by?: string | null
          target_pressure_psi?: number | null
          train_id?: string
          voltage?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "pump_readings_plant_id_fkey"
            columns: ["plant_id"]
            isOneToOne: false
            referencedRelation: "plants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pump_readings_recorded_by_fkey"
            columns: ["recorded_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pump_readings_train_id_fkey"
            columns: ["train_id"]
            isOneToOne: false
            referencedRelation: "ro_trains"
            referencedColumns: ["id"]
          },
        ]
      }
      ro_pretreatment_readings: {
        Row: {
          afm_units: Json | null
          backwash_end: string | null
          backwash_start: string | null
          bag_filters_changed: number | null
          booster_pumps: Json | null
          created_at: string
          filter_housings: Json | null
          hpp_target_pressure_psi: number | null
          id: string
          mmf_readings: Json | null
          plant_id: string
          reading_datetime: string
          recorded_by: string | null
          remarks: string | null
          train_id: string
        }
        Insert: {
          afm_units?: Json | null
          backwash_end?: string | null
          backwash_start?: string | null
          bag_filters_changed?: number | null
          booster_pumps?: Json | null
          created_at?: string
          filter_housings?: Json | null
          hpp_target_pressure_psi?: number | null
          id?: string
          mmf_readings?: Json | null
          plant_id: string
          reading_datetime?: string
          recorded_by?: string | null
          remarks?: string | null
          train_id: string
        }
        Update: {
          afm_units?: Json | null
          backwash_end?: string | null
          backwash_start?: string | null
          bag_filters_changed?: number | null
          booster_pumps?: Json | null
          created_at?: string
          filter_housings?: Json | null
          hpp_target_pressure_psi?: number | null
          id?: string
          mmf_readings?: Json | null
          plant_id?: string
          reading_datetime?: string
          recorded_by?: string | null
          remarks?: string | null
          train_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ro_pretreatment_readings_plant_id_fkey"
            columns: ["plant_id"]
            isOneToOne: false
            referencedRelation: "plants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ro_pretreatment_readings_train_id_fkey"
            columns: ["train_id"]
            isOneToOne: false
            referencedRelation: "ro_trains"
            referencedColumns: ["id"]
          },
        ]
      }
      ro_train_readings: {
        Row: {
          created_at: string
          dp_psi: number | null
          feed_flow: number | null
          feed_meter: number | null
          feed_ph: number | null
          feed_pressure_psi: number | null
          feed_tds: number | null
          id: string
          permeate_flow: number | null
          permeate_meter: number | null
          permeate_ph: number | null
          permeate_tds: number | null
          plant_id: string
          reading_datetime: string
          recorded_by: string | null
          recovery_pct: number | null
          reject_flow: number | null
          reject_meter: number | null
          reject_ph: number | null
          reject_pressure_psi: number | null
          reject_tds: number | null
          rejection_pct: number | null
          salt_passage_pct: number | null
          suction_pressure_psi: number | null
          temperature_c: number | null
          train_id: string
          turbidity_ntu: number | null
        }
        Insert: {
          created_at?: string
          dp_psi?: number | null
          feed_flow?: number | null
          feed_meter?: number | null
          feed_ph?: number | null
          feed_pressure_psi?: number | null
          feed_tds?: number | null
          id?: string
          permeate_flow?: number | null
          permeate_meter?: number | null
          permeate_ph?: number | null
          permeate_tds?: number | null
          plant_id: string
          reading_datetime?: string
          recorded_by?: string | null
          recovery_pct?: number | null
          reject_flow?: number | null
          reject_meter?: number | null
          reject_ph?: number | null
          reject_pressure_psi?: number | null
          reject_tds?: number | null
          rejection_pct?: number | null
          salt_passage_pct?: number | null
          suction_pressure_psi?: number | null
          temperature_c?: number | null
          train_id: string
          turbidity_ntu?: number | null
        }
        Update: {
          created_at?: string
          dp_psi?: number | null
          feed_flow?: number | null
          feed_meter?: number | null
          feed_ph?: number | null
          feed_pressure_psi?: number | null
          feed_tds?: number | null
          id?: string
          permeate_flow?: number | null
          permeate_meter?: number | null
          permeate_ph?: number | null
          permeate_tds?: number | null
          plant_id?: string
          reading_datetime?: string
          recorded_by?: string | null
          recovery_pct?: number | null
          reject_flow?: number | null
          reject_meter?: number | null
          reject_ph?: number | null
          reject_pressure_psi?: number | null
          reject_tds?: number | null
          rejection_pct?: number | null
          salt_passage_pct?: number | null
          suction_pressure_psi?: number | null
          temperature_c?: number | null
          train_id?: string
          turbidity_ntu?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "ro_train_readings_plant_id_fkey"
            columns: ["plant_id"]
            isOneToOne: false
            referencedRelation: "plants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ro_train_readings_recorded_by_fkey"
            columns: ["recorded_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ro_train_readings_train_id_fkey"
            columns: ["train_id"]
            isOneToOne: false
            referencedRelation: "ro_trains"
            referencedColumns: ["id"]
          },
        ]
      }
      ro_trains: {
        Row: {
          created_at: string
          id: string
          name: string | null
          num_afm: number
          num_booster_pumps: number
          num_cartridge_filters: number
          num_controllers: number
          num_filter_housings: number
          num_hp_pumps: number
          plant_id: string
          status: Database["public"]["Enums"]["train_status"]
          train_number: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          name?: string | null
          num_afm?: number
          num_booster_pumps?: number
          num_cartridge_filters?: number
          num_controllers?: number
          num_filter_housings?: number
          num_hp_pumps?: number
          plant_id: string
          status?: Database["public"]["Enums"]["train_status"]
          train_number: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string | null
          num_afm?: number
          num_booster_pumps?: number
          num_cartridge_filters?: number
          num_controllers?: number
          num_filter_housings?: number
          num_hp_pumps?: number
          plant_id?: string
          status?: Database["public"]["Enums"]["train_status"]
          train_number?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ro_trains_plant_id_fkey"
            columns: ["plant_id"]
            isOneToOne: false
            referencedRelation: "plants"
            referencedColumns: ["id"]
          },
        ]
      }
      train_status_log: {
        Row: {
          confirmed_at: string
          confirmed_by: string | null
          id: string
          plant_id: string
          reason: string | null
          status: string
          train_id: string
        }
        Insert: {
          confirmed_at?: string
          confirmed_by?: string | null
          id?: string
          plant_id: string
          reason?: string | null
          status: string
          train_id: string
        }
        Update: {
          confirmed_at?: string
          confirmed_by?: string | null
          id?: string
          plant_id?: string
          reason?: string | null
          status?: string
          train_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "train_status_log_plant_id_fkey"
            columns: ["plant_id"]
            isOneToOne: false
            referencedRelation: "plants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "train_status_log_train_id_fkey"
            columns: ["train_id"]
            isOneToOne: false
            referencedRelation: "ro_trains"
            referencedColumns: ["id"]
          },
        ]
      }
      user_profiles: {
        Row: {
          created_at: string
          designation: string | null
          first_name: string | null
          id: string
          immediate_head_id: string | null
          last_name: string | null
          middle_name: string | null
          plant_assignments: string[]
          profile_complete: boolean
          status: Database["public"]["Enums"]["profile_status"]
          suffix: string | null
          updated_at: string
          username: string | null
        }
        Insert: {
          created_at?: string
          designation?: string | null
          first_name?: string | null
          id: string
          immediate_head_id?: string | null
          last_name?: string | null
          middle_name?: string | null
          plant_assignments?: string[]
          profile_complete?: boolean
          status?: Database["public"]["Enums"]["profile_status"]
          suffix?: string | null
          updated_at?: string
          username?: string | null
        }
        Update: {
          created_at?: string
          designation?: string | null
          first_name?: string | null
          id?: string
          immediate_head_id?: string | null
          last_name?: string | null
          middle_name?: string | null
          plant_assignments?: string[]
          profile_complete?: boolean
          status?: Database["public"]["Enums"]["profile_status"]
          suffix?: string | null
          updated_at?: string
          username?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "user_profiles_immediate_head_id_fkey"
            columns: ["immediate_head_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      well_meter_replacements: {
        Row: {
          created_at: string
          id: string
          new_brand: string | null
          new_initial_reading: number | null
          new_installed_date: string | null
          new_serial: string | null
          new_size: string | null
          old_final_reading: number | null
          old_serial: string | null
          plant_id: string
          remarks: string | null
          replaced_by: string | null
          replacement_date: string
          well_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          new_brand?: string | null
          new_initial_reading?: number | null
          new_installed_date?: string | null
          new_serial?: string | null
          new_size?: string | null
          old_final_reading?: number | null
          old_serial?: string | null
          plant_id: string
          remarks?: string | null
          replaced_by?: string | null
          replacement_date: string
          well_id: string
        }
        Update: {
          created_at?: string
          id?: string
          new_brand?: string | null
          new_initial_reading?: number | null
          new_installed_date?: string | null
          new_serial?: string | null
          new_size?: string | null
          old_final_reading?: number | null
          old_serial?: string | null
          plant_id?: string
          remarks?: string | null
          replaced_by?: string | null
          replacement_date?: string
          well_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "well_meter_replacements_plant_id_fkey"
            columns: ["plant_id"]
            isOneToOne: false
            referencedRelation: "plants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "well_meter_replacements_replaced_by_fkey"
            columns: ["replaced_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "well_meter_replacements_well_id_fkey"
            columns: ["well_id"]
            isOneToOne: false
            referencedRelation: "wells"
            referencedColumns: ["id"]
          },
        ]
      }
      well_pms_records: {
        Row: {
          created_at: string
          date_gathered: string
          id: string
          motor_hp: number | null
          plant_id: string
          pump_installed: string | null
          pump_setting: string | null
          pumping_water_level_m: number | null
          record_type: string
          recorded_by: string | null
          remarks: string | null
          static_water_level_m: number | null
          tds_ppm: number | null
          turbidity_ntu: number | null
          well_id: string
        }
        Insert: {
          created_at?: string
          date_gathered: string
          id?: string
          motor_hp?: number | null
          plant_id: string
          pump_installed?: string | null
          pump_setting?: string | null
          pumping_water_level_m?: number | null
          record_type?: string
          recorded_by?: string | null
          remarks?: string | null
          static_water_level_m?: number | null
          tds_ppm?: number | null
          turbidity_ntu?: number | null
          well_id: string
        }
        Update: {
          created_at?: string
          date_gathered?: string
          id?: string
          motor_hp?: number | null
          plant_id?: string
          pump_installed?: string | null
          pump_setting?: string | null
          pumping_water_level_m?: number | null
          record_type?: string
          recorded_by?: string | null
          remarks?: string | null
          static_water_level_m?: number | null
          tds_ppm?: number | null
          turbidity_ntu?: number | null
          well_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "well_pms_records_plant_id_fkey"
            columns: ["plant_id"]
            isOneToOne: false
            referencedRelation: "plants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "well_pms_records_recorded_by_fkey"
            columns: ["recorded_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "well_pms_records_well_id_fkey"
            columns: ["well_id"]
            isOneToOne: false
            referencedRelation: "wells"
            referencedColumns: ["id"]
          },
        ]
      }
      well_readings: {
        Row: {
          created_at: string
          current_reading: number | null
          daily_volume: number | null
          gps_lat: number | null
          gps_lng: number | null
          id: string
          off_location_flag: boolean
          plant_id: string
          power_meter_reading: number | null
          previous_reading: number | null
          reading_datetime: string
          recorded_by: string | null
          well_id: string
        }
        Insert: {
          created_at?: string
          current_reading?: number | null
          daily_volume?: number | null
          gps_lat?: number | null
          gps_lng?: number | null
          id?: string
          off_location_flag?: boolean
          plant_id: string
          power_meter_reading?: number | null
          previous_reading?: number | null
          reading_datetime?: string
          recorded_by?: string | null
          well_id: string
        }
        Update: {
          created_at?: string
          current_reading?: number | null
          daily_volume?: number | null
          gps_lat?: number | null
          gps_lng?: number | null
          id?: string
          off_location_flag?: boolean
          plant_id?: string
          power_meter_reading?: number | null
          previous_reading?: number | null
          reading_datetime?: string
          recorded_by?: string | null
          well_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "well_readings_plant_id_fkey"
            columns: ["plant_id"]
            isOneToOne: false
            referencedRelation: "plants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "well_readings_recorded_by_fkey"
            columns: ["recorded_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "well_readings_well_id_fkey"
            columns: ["well_id"]
            isOneToOne: false
            referencedRelation: "wells"
            referencedColumns: ["id"]
          },
        ]
      }
      wells: {
        Row: {
          created_at: string
          diameter: string | null
          drilling_depth_m: number | null
          has_power_meter: boolean
          id: string
          meter_brand: string | null
          meter_installed_date: string | null
          meter_serial: string | null
          meter_size: string | null
          name: string
          plant_id: string
          size: string | null
          status: Database["public"]["Enums"]["plant_status"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          diameter?: string | null
          drilling_depth_m?: number | null
          has_power_meter?: boolean
          id?: string
          meter_brand?: string | null
          meter_installed_date?: string | null
          meter_serial?: string | null
          meter_size?: string | null
          name: string
          plant_id: string
          size?: string | null
          status?: Database["public"]["Enums"]["plant_status"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          diameter?: string | null
          drilling_depth_m?: number | null
          has_power_meter?: boolean
          id?: string
          meter_brand?: string | null
          meter_installed_date?: string | null
          meter_serial?: string | null
          meter_size?: string | null
          name?: string
          plant_id?: string
          size?: string | null
          status?: Database["public"]["Enums"]["plant_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "wells_plant_id_fkey"
            columns: ["plant_id"]
            isOneToOne: false
            referencedRelation: "plants"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      complete_onboarding: {
        Args: {
          _designation: string
          _first_name: string
          _last_name: string
          _middle_name: string
          _plant_assignments: string[]
          _suffix: string
          _username: string
        }
        Returns: undefined
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_admin: { Args: { _user_id: string }; Returns: boolean }
      is_manager_or_admin: { Args: { _user_id: string }; Returns: boolean }
      recompute_production_cost: {
        Args: { _date: string; _plant_id: string }
        Returns: undefined
      }
      update_own_profile: {
        Args: {
          _designation: string
          _first_name: string
          _last_name: string
          _middle_name: string
          _suffix: string
          _username: string
        }
        Returns: undefined
      }
      user_has_plant_access: { Args: { _plant_id: string }; Returns: boolean }
    }
    Enums: {
      app_role: "Operator" | "Technician" | "Manager" | "Admin"
      frequency_type: "Daily" | "Weekly" | "Monthly" | "Quarterly" | "Yearly"
      incident_status: "Open" | "InProgress" | "Resolved" | "Closed"
      plant_status: "Active" | "Inactive"
      profile_status: "Pending" | "Active" | "Suspended"
      severity_level: "Low" | "Medium" | "High" | "Critical"
      train_status: "Running" | "Offline" | "Maintenance"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["Operator", "Technician", "Manager", "Admin"],
      frequency_type: ["Daily", "Weekly", "Monthly", "Quarterly", "Yearly"],
      incident_status: ["Open", "InProgress", "Resolved", "Closed"],
      plant_status: ["Active", "Inactive"],
      profile_status: ["Pending", "Active", "Suspended"],
      severity_level: ["Low", "Medium", "High", "Critical"],
      train_status: ["Running", "Offline", "Maintenance"],
    },
  },
} as const
