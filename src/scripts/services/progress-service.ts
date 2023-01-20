import ora from 'ora';
import * as RTE from 'fp-ts/ReaderTaskEither';
import * as E from 'fp-ts/Either';
import * as RT from 'fp-ts/ReaderTask';
import { pipe } from 'fp-ts/lib/function';

export type ProgressReporter = {
  readonly start: (message: string) => {
    // eslint-disable-next-line functional/no-return-void
    readonly success: () => void;
    // eslint-disable-next-line functional/no-return-void
    readonly fail: () => void;
  };
};

export type ProgressReporterEnv = {
  readonly progressReporter: ProgressReporter;
};

export const OraProgressReporter: ProgressReporter = {
  start: (message) => {
    const spinner = ora(message).start();
    return {
      // eslint-disable-next-line functional/functional-parameters
      success: () => spinner.succeed(),
      // eslint-disable-next-line functional/functional-parameters
      fail: () => spinner.fail(),
    };
  },
};

export const withProgress = <R extends ProgressReporterEnv, E, A>(
  message: string,
  a: RTE.ReaderTaskEither<R, E, A>
): RTE.ReaderTaskEither<R, E, A> => {
  return pipe(
    // eslint-disable-next-line functional/functional-parameters
    RTE.asks<ProgressReporterEnv, ProgressReporter>(
      (env) => env.progressReporter
    ),
    RTE.chain((progressReporter) =>
      pipe(
        // eslint-disable-next-line functional/functional-parameters
        () => progressReporter.start(message),
        RTE.fromIO,
        // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types, functional/functional-parameters
        RTE.chain((reporter) =>
          pipe(
            a,
            RT.chainFirstIOK<E.Either<E, A>, unknown>(
              // eslint-disable-next-line functional/functional-parameters, functional/no-return-void
              (result) => () =>
                E.isLeft(result) ? reporter.fail() : reporter.success()
            )
          )
        )
      )
    )
  );
};
