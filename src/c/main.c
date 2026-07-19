// NL OV Departures — watch app
//
// Shows the next 5 public transport departures (from the nearest saved
// favourite stops) as a simple menu: line number + direction on the
// top line, minutes-away on the sub line. Data comes entirely from the
// PebbleKit JS companion (src/pkjs/index.js), which talks to OVapi.nl.
//
// Refresh triggers:
//   - every 30s via AppTimer
//   - manual: SELECT button click, sends REQUEST_REFRESH to JS
//
// Message keys (must match package.json "messageKeys" and index.js):
//   COUNT            - uint8, number of valid departure rows (0-5)
//   ERROR            - cstring, set by JS when something went wrong
//                       (no GPS, no favourites, network failure, etc.)
//   REQUEST_REFRESH  - uint8, sent watch->phone to force a refresh
//   LINE_n / DIR_n / MIN_n (n = 0..4) - cstring/cstring/cstring per row

#include <pebble.h>

#define MAX_DEPARTURES 5
#define REFRESH_INTERVAL_MS 30000

static Window *s_main_window;
static MenuLayer *s_menu_layer;

static AppTimer *s_refresh_timer;

typedef struct {
  char line[16];
  char direction[48];
  char minutes[8];
} Departure;

static Departure s_departures[MAX_DEPARTURES];
static uint8_t s_departure_count = 0;
static char s_status_text[64] = "Loading...";
static bool s_have_error = false;

// ---------- Forward declarations ----------
static void request_refresh(void);
static void schedule_refresh_timer(void);

// ---------- MenuLayer callbacks ----------

static uint16_t menu_get_num_sections_callback(MenuLayer *menu_layer, void *data) {
  return 1;
}

static uint16_t menu_get_num_rows_callback(MenuLayer *menu_layer, uint16_t section_index, void *data) {
  if (s_departure_count == 0) {
    return 1; // single row showing status/error text
  }
  return s_departure_count;
}

static int16_t menu_get_header_height_callback(MenuLayer *menu_layer, uint16_t section_index, void *data) {
  return MENU_CELL_BASIC_HEADER_HEIGHT;
}

static void menu_draw_header_callback(GContext *ctx, const Layer *cell_layer, uint16_t section_index, void *data) {
  menu_cell_basic_header_draw(ctx, cell_layer, "Next departures");
}

static void menu_draw_row_callback(GContext *ctx, const Layer *cell_layer, MenuIndex *cell_index, void *data) {
  if (s_departure_count == 0) {
    menu_cell_basic_draw(ctx, cell_layer, s_status_text,
                          s_have_error ? "Select to retry" : NULL, NULL);
    return;
  }

  Departure *d = &s_departures[cell_index->row];

  // Title: "12  Centraal Station"
  static char title[64];
  snprintf(title, sizeof(title), "%s  %s", d->line, d->direction);

  // Subtitle: "3 min" (or "due")
  static char subtitle[16];
  snprintf(subtitle, sizeof(subtitle), "%s min", d->minutes);

  menu_cell_basic_draw(ctx, cell_layer, title, subtitle, NULL);
}

static void menu_select_click_callback(MenuLayer *menu_layer, MenuIndex *cell_index, void *data) {
  // Any select click forces an immediate refresh, whether on a
  // departure row or the empty/error placeholder row.
  request_refresh();
}

// ---------- AppMessage ----------

static void inbox_received_callback(DictionaryIterator *iterator, void *context) {
  Tuple *count_tuple = dict_find(iterator, MESSAGE_KEY_COUNT);
  Tuple *error_tuple = dict_find(iterator, MESSAGE_KEY_ERROR);

  if (error_tuple) {
    s_have_error = true;
    strncpy(s_status_text, error_tuple->value->cstring, sizeof(s_status_text) - 1);
    s_status_text[sizeof(s_status_text) - 1] = '\0';
    s_departure_count = 0;
    menu_layer_reload_data(s_menu_layer);
    return;
  }

  if (!count_tuple) {
    // Message we don't recognise (e.g. an ack-only ping) - ignore.
    return;
  }

  s_have_error = false;
  uint8_t count = (uint8_t)count_tuple->value->uint8;
  if (count > MAX_DEPARTURES) {
    count = MAX_DEPARTURES;
  }
  s_departure_count = count;

  if (count == 0) {
    snprintf(s_status_text, sizeof(s_status_text), "No departures");
  }

  const uint32_t line_keys[MAX_DEPARTURES] = {
    MESSAGE_KEY_LINE_0, MESSAGE_KEY_LINE_1, MESSAGE_KEY_LINE_2,
    MESSAGE_KEY_LINE_3, MESSAGE_KEY_LINE_4
  };
  const uint32_t dir_keys[MAX_DEPARTURES] = {
    MESSAGE_KEY_DIR_0, MESSAGE_KEY_DIR_1, MESSAGE_KEY_DIR_2,
    MESSAGE_KEY_DIR_3, MESSAGE_KEY_DIR_4
  };
  const uint32_t min_keys[MAX_DEPARTURES] = {
    MESSAGE_KEY_MIN_0, MESSAGE_KEY_MIN_1, MESSAGE_KEY_MIN_2,
    MESSAGE_KEY_MIN_3, MESSAGE_KEY_MIN_4
  };

  for (uint8_t i = 0; i < count; i++) {
    Tuple *line_t = dict_find(iterator, line_keys[i]);
    Tuple *dir_t = dict_find(iterator, dir_keys[i]);
    Tuple *min_t = dict_find(iterator, min_keys[i]);

    if (line_t) {
      strncpy(s_departures[i].line, line_t->value->cstring, sizeof(s_departures[i].line) - 1);
      s_departures[i].line[sizeof(s_departures[i].line) - 1] = '\0';
    }
    if (dir_t) {
      strncpy(s_departures[i].direction, dir_t->value->cstring, sizeof(s_departures[i].direction) - 1);
      s_departures[i].direction[sizeof(s_departures[i].direction) - 1] = '\0';
    }
    if (min_t) {
      strncpy(s_departures[i].minutes, min_t->value->cstring, sizeof(s_departures[i].minutes) - 1);
      s_departures[i].minutes[sizeof(s_departures[i].minutes) - 1] = '\0';
    }
  }

  menu_layer_reload_data(s_menu_layer);
}

static void inbox_dropped_callback(AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_ERROR, "Inbox dropped: %d", (int)reason);
}

static void outbox_failed_callback(DictionaryIterator *iterator, AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_ERROR, "Outbox send failed: %d", (int)reason);
}

static void outbox_sent_callback(DictionaryIterator *iterator, void *context) {
  // no-op
}

static void request_refresh(void) {
  DictionaryIterator *iter;
  AppMessageResult result = app_message_outbox_begin(&iter);
  if (result != APP_MSG_OK) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "outbox_begin failed: %d", (int)result);
    return;
  }
  dict_write_uint8(iter, MESSAGE_KEY_REQUEST_REFRESH, 1);
  app_message_outbox_send();

  // Reset the periodic timer so we don't double-fire right after a
  // manual refresh.
  schedule_refresh_timer();
}

// ---------- Timer ----------

static void refresh_timer_callback(void *data) {
  request_refresh();
}

static void schedule_refresh_timer(void) {
  if (s_refresh_timer) {
    app_timer_cancel(s_refresh_timer);
  }
  s_refresh_timer = app_timer_register(REFRESH_INTERVAL_MS, refresh_timer_callback, NULL);
}

// ---------- Window lifecycle ----------

static void main_window_load(Window *window) {
  Layer *window_layer = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(window_layer);

  s_menu_layer = menu_layer_create(bounds);
  menu_layer_set_callbacks(s_menu_layer, NULL, (MenuLayerCallbacks){
    .get_num_sections = menu_get_num_sections_callback,
    .get_num_rows = menu_get_num_rows_callback,
    .get_header_height = menu_get_header_height_callback,
    .draw_header = menu_draw_header_callback,
    .draw_row = menu_draw_row_callback,
    .select_click = menu_select_click_callback,
  });
  menu_layer_set_click_config_onto_window(s_menu_layer, window);
  layer_add_child(window_layer, menu_layer_get_layer(s_menu_layer));
}

static void main_window_unload(Window *window) {
  menu_layer_destroy(s_menu_layer);
}

static void init(void) {
  s_main_window = window_create();
  window_set_window_handlers(s_main_window, (WindowHandlers){
    .load = main_window_load,
    .unload = main_window_unload,
  });
  window_stack_push(s_main_window, true);

  app_message_register_inbox_received(inbox_received_callback);
  app_message_register_inbox_dropped(inbox_dropped_callback);
  app_message_register_outbox_failed(outbox_failed_callback);
  app_message_register_outbox_sent(outbox_sent_callback);
  app_message_open(app_message_inbox_size_maximum(), app_message_outbox_size_maximum());

  // Kick off an initial fetch as soon as JS is ready, then keep polling.
  request_refresh();
}

static void deinit(void) {
  if (s_refresh_timer) {
    app_timer_cancel(s_refresh_timer);
  }
  window_destroy(s_main_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
