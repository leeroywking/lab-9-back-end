'use strict'

// Load environment variables
require('dotenv').config();

//Load express to do the heavey lifting -- Application dependencies
const express = require('express');
const superagent = require('superagent');
const cors = require('cors'); //Cross Origin Resource Sharing
const pg = require('pg'); //postgress

//Application setup
const app = express();
app.use(cors()); //tell express to use cors
const PORT = process.env.PORT;

//connect to database
const client = new pg.Client(process.env.DATABASE_URL); // part of posgres library
client.connect();
client.on('error', err => console.log(err));

app.get('/location', searchToLatLong)
app.get('/weather', getWeather);
app.get('/events', getEvent);
app.get('/movies', getMovies);
app.get('/yelp', getYelp);

//server listening for requests
app.listen(PORT, ()=> console.log(`city explorer back end Listening on PORT ${PORT}`));

function getDataFromDB(sqlInfo){
  // create sql statement
  let condition = '';
  let values = [];

  if (sqlInfo.searchQuery){
    condition = 'search_query';
    values = [sqlInfo.searchQuery];
  } else {
    condition = 'location_id';
    values = [sqlInfo.id];
  }

  let sql = `SELECT * FROM ${sqlInfo.endpoint}s WHERE ${condition}=$1`;

  // Get the data and return it
  try {return client.query(sql, values);}
  catch(error){ handleError(error);}
}

function saveDataToDB(sqlInfo){
  // param placeholder
  let params = [];

  for (let i=1; i<= sqlInfo.values.length;i++){
    params.push(`$${i}`)
  }

  let sqlParams = params.join();

  let sql = '';
  if (sqlInfo.searchQuery){
    // loc
    sql = `INSERT INTO ${sqlInfo.endpoint}s (${sqlInfo.columns}) VALUES (${sqlParams}) RETURNING ID;`
  } else {
    // all other endpoints since loc is a little special
    sql = `INSERT INTO ${sqlInfo.endpoint}s (${sqlInfo.columns}) VALUES (${sqlParams});`
  }

  // save all this hardly won data nom nom nom

  try {return client.query(sql, sqlInfo.values);}
  catch(err){handleError(err);}
}

function checkTimeouts(sqlInfo, sqlData) {

  const timeouts = {
    weather: 15 * 1000, // 15-seconds
    yelp: 24 * 1000 * 60 * 60, // 24-Hours
    movie: 30 * 1000 * 60 * 60 * 24, // 30-Days
    event: 6 * 1000 * 60 * 60, // 6-Hours
    trail: 7 * 1000 * 60 * 60 * 24 // 7-Days
  };

  // if there is data, find out how old it is.
  if (sqlData.rowCount > 0) {
    let ageOfResults = (Date.now() - sqlData.rows[0].created_at);

    // For debugging only
    console.log(sqlInfo.endpoint, ' AGE:', ageOfResults);
    console.log(sqlInfo.endpoint, ' Timeout:', timeouts[sqlInfo.endpoint]);

    // Compare the age of the results with the timeout value
    // Delete the data if it is old
    if (ageOfResults > timeouts[sqlInfo.endpoint]) {
      let sql = `DELETE FROM ${sqlInfo.endpoint}s WHERE location_id=$1;`;
      let values = [sqlInfo.id];
      client.query(sql, values)
        .then(() => { return null; })
        .catch(error => handleError(error));
    } else { return sqlData; }
  }
}

function searchToLatLong(request, response){
  let query = request.query.data;
  // console.log('line31','query=', query, 'request=', request, 'request.query.data=', request.query.data); //seattle
  // query is city --  request is a bunch of info
  // define the search

  let sql = `SELECT * FROM locations WHERE search_query=$1;`;
  let values = [query]; //always array
  // console.log('line 37', 'sql=',sql, 'values=',values);

  //make the query fo the database
  client.query(sql, values)
    .then (result => {
      // did the db return any info?
      // console.log('line 43','result from Database=', result.rowCount); // =0 if empty
      if (result.rowCount > 0) {
        response.send(result.rows[0]);
      }else {
        // console.log('line 47','results=', result.rows);
        //otherwise go get the data from the api
        const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${request.query.data}&key=${process.env.GEOCODE_API_KEY}`;
        // console.log('line 50','url=', url);
        superagent.get(url)


          .then(result => {
            if (!result.body.results.length) {throw 'NO DATA';}
            else {
              let location = new Location(query, result.body.results[0]);
              let newSQL = `INSERT INTO locations (search_query, formatted_address, latitude, longitude) VALUES ($1, $2, $3, $4) RETURNING ID;`;
              let newValues = Object.values(location);

              client.query(newSQL, newValues)
                .then( data => {
                  //attach returnilng id to the location object
                  location.id = data.rows[0].id;
                  response.send(location);
                });
            }
          })
          .catch(err => handleError(err, response));
      }
    })
}

function getWeather(request, response) {
  let query = request.query.data.id;
  let sql = `SELECT * FROM weathers WHERE location_id=$1;`;
  let values = [query]; //always array

  client.query(sql, values)
    .then (result => {
      if (result.rowCount > 0) {
        // console.log('line 92','Weather from SQL', 'results.rows=', result.rows);
        response.send(result.rows);


      } else {
        const url = `https://api.darksky.net/forecast/${process.env.WEATHER_API_KEY}/${request.query.data.latitude},${request.query.data.longitude}`;

        return superagent.get(url)
          .then(weatherResults => {
            // console.log('line 101','weather from API');
            if (!weatherResults.body.daily.data.length) { throw 'NO DATA'; }
            else {
              const weatherSummaries = weatherResults.body.daily.data.map( day => {
                let summary = new Weather(day);
                summary.id = query;

                let newSql = `INSERT INTO weathers (forecast, time, location_id) VALUES($1, $2, $3);`;
                let newValues = Object.values(summary);
                // console.log('line 110', 'newValues=',newValues);
                client.query(newSql, newValues);
                return summary;
              });
              response.send(weatherSummaries);
            }
          })
          .catch(err => handleError(err, response));
      }
    });
}

function getEvent(request, response) {
  let query = request.query.data.id;
  let sql = `SELECT * FROM events WHERE location_id=$1;`;
  let values = [query]; //always array

  client.query(sql, values)
    .then (result => {
      if (result.rowCount > 0) {
        // console.log('line 135','events from SQL', 'result.rows=', result.rows);
        response.send(result.rows);


      } else {
        const url = `https://www.eventbriteapi.com/v3/events/search/?token=${process.env.EVENTBRITE_API_KEY}&location.latitude=${request.query.data.latitude}&location.longitude=${request.query.data.longitude}`;

        return superagent.get(url)
          .then(eventResults => {
            // console.log('events from API');
            if (!eventResults.body.events.length) { throw 'NO DATA'; }
            else {
              const eventSummaries = eventResults.body.events.map( events => {
                let summary = new Event(events);
                summary.id = query;

                let newSql = `INSERT INTO events (link, name, summary, event_date, location_id) VALUES($1, $2, $3, $4, $5);`;
                let newValues = Object.values(summary);
                // console.log(newValues);
                client.query(newSql, newValues);
                return summary;
              });
              response.send(eventSummaries);
            }
          })
          .catch(err => handleError(err, response));
      }
    });
}

function getMovies(request, response) {
  let query = request.query.data.id; //1
  // console.log('line168', 'query=', query);
  let sql = `SELECT * FROM movies WHERE location_id=$1;`;
  let values = [query]; //always array  [1]
  // console.log('line170', 'values=', values);

  client.query(sql, values)
    .then (result => {
      if (result.rowCount > 0) {
        // console.log('line 174','movies from SQL', 'result.rows=', result.rows);
        response.send(result.rows);

      } else {
        const url = `https://api.themoviedb.org/3/search/movie?api_key=${process.env.MOVIE_API_KEY}&language=en-US&query=${request.query.data}&page=1&include_adult=false`;
        console.log('url', url, 'true');
        // console.log('line 181','data', request);
        // console.log('line 182', 'response=',response);
        return superagent.get(url)
          .then(movieResults => {
            // console.log('movies from API', movieResults);
            // console.log('line 189', 'movieResults=', movieResults);
            if (!movieResults.body.results.length) { throw 'NO DATA'; }
            else {
              const movieSummaries = movieResults.body.results.map( movie => {
                let summary = new Movie(movie);
                // console.log('line 195', 'summary=', summary);
                summary.id = query;

                let newSql = `INSERT INTO movies (title, overview, average_votes, total_votes, image_url, popularity, released_on, location_id) VALUES($1, $2, $3, $4, $5, $6, $7, $8);`;
                let newValues = Object.values(summary);
                // console.log('line 199', 'newValue=',newValues);
                client.query(newSql, newValues);
                return summary;
              });
              response.send(movieSummaries);
            }
          })
          .catch(err => handleError(err, response));
      }
    });
}

function getYelp (request, response) {
  let query = request.query.data.id; //1
  console.log('line197***************************************', 'query=', request.query.data, '*************************************');
  let sql = `SELECT * FROM yelps WHERE location_id=$1;`;
  let values = [query]; //always array  [1]
  console.log('line200***************************************', 'values=', values, '****************************************');

  client.query(sql, values)
    .then (result => {
      if (result.rowCount > 0) {
        console.log('line 205**********************','movies from SQL', 'result.rows=', result.rows, '**********************');
        response.send(result.rows);

      } else {
        const url = `https://api.yelp.com/v3/businesses/search?latitude=${request.query.data.latitude}&longitude=${request.query.data.longitude}`;
        console.log('line 210','url', url, '*****************************************true*******************************************************');
        console.log('line 211','***********************************','data', request, '************************************');
        console.log('line 212**************************************', 'response=',response, '*****************************');
        return superagent.get(url)
          .set({'Authorization': 'Bearer '+ process.env.YELP_API_KEY})
          .then(yelpResults => {
            console.log('********************************yelp from API******************************************', yelpResults);
            console.log('line 189', '*********************************', 'movieResults=', yelpResults, '**********************************');
            if (!yelpResults.body.businesses.length) { throw 'NO DATA'; }
            else {
              const yelpSummaries = yelpResults.body.businesses.map( biz => {
                let summary = new Yelp(biz);
                // console.log('line 195', 'summary=', summary, '***************************************************************************');
                summary.id = query;

                let newSql = `INSERT INTO yelps (name, image_url, price, rating, url, location_id) VALUES($1, $2, $3, $4, $5, $6);`;
                let newValues = Object.values(summary);
                // console.log('************************************line 199', 'newValue=',newValues, '**************************************************************************');
                client.query(newSql, newValues);
                return summary;
              });
              response.send(yelpSummaries);
            }
          })
          .catch(err => handleError(err, response));
      }
    });
}

// Constructors 
function Location(query, location) {
  this.search_query = query;
  this.formatted_query = location.formatted_address;
  this.latitude = location.geometry.location.lat;
  this.longitude = location.geometry.location.lng;
}

function Weather(day) {
  this.forecast = day.summary;
  this.time = new Date(day.time * 1000).toString().slice(0, 15);
}

function Event(event) {
  this.link = event.url;
  this.name = event.name.text;
  this.summary = event.summary;
  this.event_date = new Date(event.start.local).toString().slice(0, 15);
}

function Movie (movie) {
  this.title = movie.original_title;
  this.overview = movie.overview;
  this.average_votes = movie.vote_average;
  this.total_votes = movie.vote_count;
  this.image_url = `https://image.tmdb.org/t/p/original${movie.poster_path}` ;
  this.popularity = movie.popularity;
  this.released_on = movie.release_date;
}

function Yelp (yelp) {
  this.name = yelp.name;
  this.image_url = yelp.image_url;
  this.price = yelp.price;
  this.rating = yelp.rating;
  this.url = yelp.url;
}

//error handler
function handleError(err, response) {
  console.log(err);
  if (response) response.status(500).send('Sorry something went wrong');
}
