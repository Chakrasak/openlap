import { Component, OnDestroy, OnInit } from '@angular/core';
import { ActivatedRoute } from '@angular/router';

import { PopoverController, Platform } from '@ionic/angular';

import { TranslateService } from '@ngx-translate/core';

import { Observable, Subscription, from, of, merge } from 'rxjs';
import { combineLatest as combineLatestCreate } from 'rxjs';
import { combineLatest, concat, concatAll, distinctUntilChanged, filter, map, mergeMap, pairwise, share, skipWhile, startWith, switchMap, take, withLatestFrom } from 'rxjs/operators';

import { AppSettings, Options, RaceOptions } from '../app-settings';
import { ControlUnit } from '../carrera';
import { AppService, ControlUnitService, LoggingService, SpeechService } from '../services';

import { LeaderboardItem } from './leaderboard';
import { RmsMenu } from './rms.menu';
import { Session } from './session';

const ORIENTATION = {
  portrait: 'code',
  landscape: 'number name'
};

const FIELDS = [{
  // no fuel/pit lane
  practice: [
    'bestlap gap int lastlap laps status',
    'bestlap sector1 sector2 sector3 lastlap status'
  ],
  qualifying: [
    'bestlap gap int lastlap laps status',
    'bestlap sector1 sector2 sector3 lastlap status'
  ],
  race: [
    'time bestlap lastlap laps status',
    'time sector1 sector2 sector3 lastlap status',
  ]
}, {
  // with fuel/pit lane
  practice: [
    'bestlap gap int lastlap laps fuel status',
    'bestlap sector1 sector2 sector3 lastlap fuel status'
  ],
  qualifying: [
    'bestlap gap int lastlap laps fuel status',
    'bestlap sector1 sector2 sector3 lastlap fuel status'
  ],
  race: [
    'time bestlap lastlap laps pits fuel status',
    'time sector1 sector2 sector3 lastlap fuel status'
  ]
}];

@Component({
  templateUrl: 'rms.page.html',
})
export class RmsPage implements OnDestroy, OnInit {

  mode: string;

  session: Session;

  options: Options;
  
  fields: Observable<string[]>;
  order: Observable<string>;

  lapcount: Observable<{count: number, total: number}>;
  pitlane: Observable<boolean>;

  start: Observable<number>;
  timer: Observable<number>;

  ranking: Observable<LeaderboardItem[]>;

  private subscriptions: Subscription;

  private backButtonSubscription: Subscription;

  private dataSubscription: Subscription;

  private subscription = new Subscription();

  constructor(public cu: ControlUnitService, private app: AppService,
    private logger: LoggingService, private settings: AppSettings, private speech: SpeechService,
    private popover: PopoverController, private translate: TranslateService, route: ActivatedRoute)
  {
    this.mode = route.snapshot.paramMap.get('mode') || 'practice';  // assume constant for page
        
    const cuMode = cu.pipe(
      filter(cu => !!cu),
      mergeMap(cu => cu.getMode()), 
      startWith(0),
      distinctUntilChanged()
    );

    this.fields = combineLatestCreate(cuMode, app.orientation, settings.getOptions()).pipe(
      map(([mode, orientation, options]) => {
        const f = FIELDS[mode & 0x03 ? 1 : 0][this.mode][options.sectors ? 1 : 0];
        return (ORIENTATION[orientation] + ' ' + f).split(/\s+/);
      })
    );

    this.order = combineLatestCreate(settings.getOptions()).pipe(
      map(([options]) => options.fixedorder ? 'number' : 'position')
    );

    this.pitlane = cuMode.pipe(
      map(value => (value & 0x04) != 0)
    );

    this.start = cu.pipe(
      filter(cu => !!cu),
      mergeMap(cu => cu.getStart()),
      distinctUntilChanged()
    );
  }

  ngOnInit() {
    this.subscription.add(combineLatestCreate(this.cu, this.getRaceOptions(this.mode)).subscribe(([cu, options]) => {
      if (cu && options) {
        this.session = this.startSession(cu, options);
      } else {
        this.session = null;
      }
    }));
    this.subscription.add(this.settings.getOptions().subscribe(options => {
      this.options = options;
    }));
  }

  startSession(cu: ControlUnit, options: RaceOptions) {
    const session = new Session(cu, options);

    this.lapcount = session.currentLap.pipe(map(lap => {
      return {
        count: lap,
        total: options.laps
      };
    }));

    const drivers = this.settings.getDrivers().pipe(switchMap(drivers => {
      const observables = drivers.map((obj, index) => {
        const code = obj.code || '#' + (index + 1);
        if (obj.name) {
          return of({name: obj.name, code: code, color: obj.color});
        } else {
          return this.getTranslations('Driver {{number}}', {number: index + 1}).pipe(map((name: string) => {
            return {name: name, code: code, color: obj.color}
          }));
        }
      });
      return combineLatestCreate(...observables);
    }));

    const best = [Infinity, Infinity, Infinity, Infinity];
    const events = merge(
      session.grid.pipe(
        map(obs => obs.pipe(pairwise())),
        mergeMap(obs => obs),
        mergeMap(([prev, curr]) => {
          const events = [];
          curr.best.forEach((time, index) => {
            if ((time || Infinity) < best[index]) {
              best[index] = time;
              if (curr.laps >= 3) {
                events.push([index ? 'bests' + index : 'bestlap', curr.id]);
              }
            }
          });
          if (!curr.finished && curr.time) {
            if (curr.fuel < prev.fuel) {
              events.push(['fuel' + curr.fuel, curr.id]);
            }
            if (curr.pit && !prev.pit) {
              events.push(['pitenter', curr.id]);
            }
            if (!curr.pit && prev.pit) {
              events.push(['pitexit', curr.id]);
            }
          }
          return from(events);
        }),
      ),
      this.start.pipe(
        distinctUntilChanged(),
        filter(value => value === 9),
        map(() => {
          return ['falsestart', null];
        })
      ),
      this.lapcount.pipe(
        filter(laps => {
          return options.laps && laps.count === options.laps && !session.finished.value;
        }),
        map(() => {
          return ['finallap', null];
        })
      ),
      session.yellowFlag.pipe(
        distinctUntilChanged(),
        skipWhile(value => !value),
        map(value => {
          return [value ? 'yellowflag' : 'greenflag', null];
        })
      ),
      session.finished.pipe(
        distinctUntilChanged(),
        filter(finished => finished),
        map(() => {
          return ['finished', null];
        })
      )
    ).pipe(
      withLatestFrom(drivers),
      map(([[event, id], drivers]) => {
        return <[string, any]>[event, id !== null ? drivers[id] : null];
      })
    );

    // TODO: convert to Observable.scan()?
    const gridpos = [];
    const pitfuel = [];
    this.ranking = session.ranking.pipe(
      combineLatest(drivers),
      map(([ranks, drivers]) => {
        return ranks.map((item, index) => {
          if (options.mode == 'race' && gridpos[item.id] === undefined && item.time !== undefined) {
            gridpos[item.id] = index;
          }
          if (!item.pit || item.fuel < pitfuel[item.id]) {
            pitfuel[item.id] = item.fuel;
          }
          return Object.assign({}, item, {
            position: index,
            driver: drivers[item.id],
            gridpos: gridpos[item.id],
            refuel: item.pit && item.fuel > pitfuel[item.id]
          });
        });
      }),
      share()
    );

    if (this.subscriptions) {
      this.subscriptions.unsubscribe();
    }
    this.subscriptions = events.pipe(withLatestFrom(
      this.settings.getOptions(),
      this.settings.getNotifications(),
      this.getTranslations('notifications')
    )).subscribe(([[event, driver], options, notifications, translations]) => {
      this.logger.debug('Race event: ' + event, driver);
      if (options.speech && notifications[event] && notifications[event].enabled) {
        let message = notifications[event].message || translations[event];
        if (driver && driver.name) {
          this.speech.speak(driver.name + ': ' + message);
        } else {
          this.speech.speak(message);
        }
      }
    });

    this.subscriptions.add(
      this.lapcount.subscribe(
        laps => {
          cu.setLap(laps.count);
        },
        error => {
          this.logger.error('Lap counter error:', error);
        },
        () => {
          this.logger.info('Lap counter finished');
        }
      )
    );

    if (options.mode != 'practice') {
      const start = cu.getStart();
      start.pipe(take(1)).toPromise().then(value => {
        if (value === 0) {
          cu.toggleStart();
        }
        // wait until startlight goes off; TODO: subscribe/unsibscribe?
        cu.getStart().pipe(pairwise(),filter(([prev, curr]) => {
          return prev != 0 && curr == 0;
        }),take(1),).toPromise().then(() => {
          this.logger.info('Start ' + options.mode + ' mode');
          session.start();
        });
      });
    }

    return session;
  }

  ngOnDestroy() {
    this.subscription.unsubscribe();
    if (this.subscriptions) {
      this.subscriptions.unsubscribe();
    }
    if (this.dataSubscription) {
      this.dataSubscription.unsubscribe();
    }
  }

  ionViewDidEnter(){
    this.backButtonSubscription = this.app.backButton.subscribe(() => {
      // TODO: confirm or press back button twice?
      if (this.cu.value) {
        this.cu.value.disconnect().catch(error => {
          this.logger.error('Error disconnecting from CU:', error);
        }).then(() => {
          this.app.exit();
        });
      } else {
        this.app.exit();
      }
    });
  }

  ionViewWillLeave(){
    this.backButtonSubscription.unsubscribe();
  }

  restartSession() {
    if (this.session) {
      this.session = this.startSession(this.session.cu, this.session.options);
    }
  }

  cancelSession() {
    if (this.session) {
      this.session.stop();
    }
  }

  private getRaceOptions(mode: string) {
    switch (mode) {
      case 'race':
        return this.settings.getRaceSettings();
      case 'qualifying':
        return this.settings.getQualifyingSettings();
      default:
        return of(new RaceOptions('practice'));
    }
  }

  toggleSpeech() {
    if (this.options) {
      this.settings.setOptions(Object.assign({}, this.options, {speech: !this.options.speech}));
    }
  }

  toggleYellowFlag() {
    if (this.session) {
      this.session.toggleYellowFlag();
    }
  }

  showMenu(event: Event) {
    return this.popover.create({
      component: RmsMenu,
      componentProps: {
        mode: this.mode,
        active: this.session && !this.session.finished.value && this.mode != 'practice',
        restart: () => this.restartSession(),
        cancel:  () => this.cancelSession()
      }, 
      event: event
    }).then(menu => {
      menu.present();
    });
  }

  // see https://github.com/ngx-translate/core/issues/330
  private getTranslations(key: string, params?: Object) {
    return this.translate.get(key, params).pipe(
      concat(this.translate.onLangChange.asObservable().pipe(
        map(() => this.translate.get(key, params)),
        concatAll()
      )
    ));
  }
}
